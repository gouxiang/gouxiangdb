# P1 权限改造 · 文件级实施切片设计（方案二）

- 日期：2026-09-23
- 状态：**已定稿**（团队负责人终审通过，四条开放问题裁决见下「定稿裁决」节，对应小节内联标注）
- 基线：HEAD `055fe40`，根版本 `0.1.7`，数据库迁移 36 枚
- 文档性质：纯设计，不改任何生产代码；供团队负责人与后端开发逐文件照做
- 上游裁决：戴总已拍板「方案二」——上线前彻底做完 M4 引擎、把当前生效权限完整搬入、双轨对拍零差异后才通电切换，并始终保留一键回退
- 图标纪律：本文不使用 emoji 作为功能图标；前端图标库沿用现有 SVG 体系，不在本切片新增选型

---

## 定稿裁决（团队负责人终审，2026-09-23）

团队负责人已逐条审阅并独立核实关键前提：nav node id 为确定性生成——`apps/api/src/domain/nav/backfill.ts:20` `nodeId = nav_<kind>_<resourceId>`，创建时显式传入。因此路线 (a)（库可见逐表展开为挂 table 节点、带 fieldMask 的角色策略）成立、无洞，§4 映射规则照此执行。四条开放问题裁决如下：

1. **动作命名与挂载**：认可新增第 8 枚 ResourceAction `manage_table`，挂**库节点**（不采用 `admin_table` 命名）。详见 §6.1、§4.3、§4.6。
2. **回退开关**：认可零迁移方案——用现有 `app_settings` 单键 `authz.enforce=v2scope|engine`，缺省跟随 env / `AUTHZ_ENFORCE_READY`，`GX_AUTHZ_ENGINE=off` 作为第二道兜底；**不新增列、不新增表**。详见 §8.4。
3. **评论权保持现状**：只读 viewer **不给** comment；comment 跟随内容 `c/u/d`（即 `permit().canComment = canEditData`），本期不借机放权。详见 §4.3、§4.4。
4. **行级 conditions**：认可**不纳入** shadow 布尔零差异门；行级为新能力、第二代无对应，由 §9.4 独立用例（fail-closed / currentUser）保证正确性，须全绿但不阻塞零差异判据。详见 §6.4、§9.4、§10。

---

## 1. 目标与不做什么

### 1.1 本次要交付的四件事

1. **接对管子**：把第二代唯一生效配置 `role_library_scope` 的当前全部内容（角色 × 库 × 表 × 字段，含 `canManage` / `visible` / `canShare` 以及管理员的隐含授权）完整、准确投影成 `auth_policies`；所有写点在同一事务内双写，保证两轨永远同步。
2. **表级管理位独立**：在引擎/契约侧把「重命名 / 删除表 / 进表单设计器 / 可见行控制」从「数据 CRUD」与库级 `canManage` 中解耦，不再出现 `canManageSchema = canManage` 这种绑死。
3. **可见行条件闭合**：开放 `auth_policies.conditions` 的写入口，实现最小形态的行级条件求值（当前 `conditions` 恒为 `null`）。
4. **零差异切换**：在真实库与规模夹具上把 shadow 双轨对拍跑到 OVERDENY / OVERALLOW 双零，满足就绪条件后才翻 `AUTHZ_ENFORCE_READY`，并保留一键回退到 `role_library_scope`。

### 1.2 明确不做（防范围膨胀）

- 不做物理删旧轨：`role_library_scope` 在观察期内保留为回退与对拍基准；其退出另立 ADR，本切片不摘表、不删列。
- 不新增业务表、不新增列（零迁移）：全部能力用现有 `auth_policies` / `nav_nodes` / `conditions` 承载；回退开关也用现有 `app_settings` 承载而非新表（见 §8.4，团队负责人裁决 2）。
- 不引入 deny 语义、不做审批流 / ABAC 自由表达式、不做多租户与 SSO。
- 不改前端图标库、不新增运行时依赖。
- 不并入历史遗留（`tables.ts` 拆分、分享链接访客问题等）。
- 行级条件本期只做「可见行收敛」这一最小形态，不做任意跨资源自由条件。

---

## 2. 现状证据（带文件:行号）

### 2.1 三代权限叠加的实际拓扑

```
                         进请求
                           |
        +------------------+-------------------+
        |                  |                   |
   第一代(已退登记本)   第二代(唯一真生效)    第三代 M4(默认 off)
   member             libraryPolicy.ts      engine.ts decide()
   kb_member          resolveBaseAccess     读 auth_policies+nav_nodes
   kb_doc_acls        :213 读               纯 allow
   不再放行           role_library_scope    GX_AUTHZ_ENGINE 门控
   仍有写入(台账/反写) 按角色×库×表×字段     AUTHZ_ENFORCE_READY=false
                                           env=on 也先降级 shadow
```

### 2.2 关键证据清单

| 事实 | 证据 |
|---|---|
| 第二代是库/表/字段放行唯一裁决函数 | `apps/api/src/domain/authz/libraryPolicy.ts:213` `resolveBaseAccess()`；文件头注释 :1-7 声明「全仓库只有这里算」 |
| 超管全权短路、管理员进全库但管理权仍在配置 | `libraryPolicy.ts:197`（`SUPER_ADMIN_ROLE_ID` 返 `SUPER_ACCESS` :57-66）、`:205-208`（管理员叠加 `visible/canToggleShare/canShare`） |
| `canManage` 产生通配全表全权 | `libraryPolicy.ts:113` `if (canManage) tables[WILDCARD_TABLE] = FULL_TABLE_ACCESS`；`WILDCARD_TABLE="*"` :55 |
| 表动作解析：通配优先 → 精确配置 → 库可见即只读 | `libraryPolicy.ts:136-142` `tableAccessOf()` |
| 字段三档默认 `editable`，独立于表动作判定 | `libraryPolicy.ts:148-150` `fieldAccessOf()` 返回 `access.fields[tableId]?.[fieldId] ?? "editable"` |
| 写字段闸：仅 `visible`/`hidden` 不可写 | `libraryPolicy.ts:158-176` `humanCanWriteField()` / `fieldWriteGate()` |
| scope config 形状与坏输入容错 | `apps/api/src/domain/authz/libraryScopeConfig.ts:23-34` `parseConfig()`；`tables:{read,create,update,delete}`、`fields:{[tableId]:{[fieldId]:'editable'|'visible'|'hidden'}}` |
| PUT library-scopes 为整角色整体替换 | `apps/api/src/routes/v1/org/roleLibraryScopes.ts:80-142`；删除缺行 :105-109、upsert :110-130，均在 `withWriteTx` 内 :97 |
| 建库同事务种管理员两行 | `apps/api/src/domain/authz/libraryScopeSeed.ts:18-30` `seedAdminScopeTx()`；接线点 `routes/bases.ts:189`、`routes/kb/index.ts:110` |
| M4 决策入口（纯 allow、conditions 不求值） | `apps/api/src/domain/authz/engine.ts:82-99` `decide()`；行级不求值注释 :77-81 |
| 判定内核（creator/owner 兜底 → 动作命中 → fieldPasses） | `apps/api/src/domain/authz/evaluate.ts:96-109` `evaluateChainDecision()`；字段闸 :63-69 |
| 三源 OR 已支持 role（`roleId IN`） | `apps/api/src/domain/authz/repository.ts:47-86` `policiesOnNodesTx()`；role 分支 :58-60 |
| 宽来源存在即全字段可见，窄掩码失效 | `apps/api/src/domain/authz/fieldMask.ts:96-102`（`if (!p.fieldMask || allowFields===undefined) visibleAll=true`）；并集只增不减注释 :1-7 |
| 写掩码 fail-closed 纯函数已存在 | `fieldMask.ts:222-259` `writeOnlyFieldCapability()` / `assertWriteOnlyFields()` |
| shadow 分类与计数已就绪 | `apps/api/src/domain/authz/shadow.ts:71-74` `classifyDrift()`、`:80-142` `DriftRegistry` |
| shadow 总入口（旧决策为准，永不抛错影响响应） | `apps/api/src/domain/authz/adapter.ts:124-143` `runShadowCheck()` |
| 旧守卫把 schema 管理权绑死 canManage | `apps/api/src/guards.ts:64-77` `permit()`：`canManageSchema: access.canManage`（:70） |
| 表级管理动作目前只有 base 级守卫承载 | `guards.ts:176-202` `requireCanManageSchema`（manage_schema）、`requireCanManageBase`（manage_share） |
| `conditions` 非空被对账拦截 | `apps/api/src/domain/authz/reconcile.ts:164-167`（C5）；开放点在此 |
| 角色删除目前不清理 scope/投影 | `apps/api/src/domain/org/roleAdmin.ts:146-180` `deleteRole()`：仅置 `deletedAt` :177，未触 scope 行与角色策略 |
| 动态筛选 currentUser 底座已具备 | `packages/shared-types/src/filters.ts:41-55`（`valueType:"dynamic"`, `dynamicValue:"currentUser"`），求值 `packages/shared-types/src/filter.ts` |

### 2.3 头号风险（再次锚定）

M4 当前的 `auth_policies` 投影源是第一代旧三表：`backfill.ts` / `projection.ts` 只产出 `reason='legacy:*'`、`subjectType="user"` 的策略（`backfill.ts:11-15,57-93`），**完全没有接第二代 `role_library_scope`**。直接翻 on，引擎认的是旧台账，戴总现配权限会整体错乱。因此 §3 的路线选择与 §5 的投影替换必须先于任何通电动作。

---

## 3. 核心难点与路线抉择

### 3.1 难点精确陈述

M4 是纯 allow + 祖先链「多源并集取最宽」。第二代在「库 `visible=1` / `canManage=1`」时默认全表、全字段宽放行，**同时允许对某一张表的字段做精确收窄**（`fields[tableId][fieldId]='visible'|'hidden'`）。

但 `fieldMask.ts:96-102` 明确：任一 r 来源 `fieldMask=null`（或无 `allowFields`）即 `visibleAll=true`，同链上窄来源的掩码被冲掉。库节点上无 mask 的宽 r 经祖先链下放到每张表节点，于是「单表字段收窄」在当前引擎语义下无法表达。这是必须正面解决的核心矛盾。

### 3.2 路线 (a)：库可见展开为「逐表」带 mask 角色策略

做法：库节点不再投影无 mask 的宽 r（CRUD 维度），而是把「库可见 / 可管理」在投影期展开到每张 table 节点的一条 `subjectType="role"` 策略；字段收窄直接以该 table 节点策略的 `fieldMask` 承载。table 节点链上因此只有「自身那条窄 r」，不再有祖先宽 r，`visibleAll` 不被触发。

- 写放大：1 条 scope 行 → N（库内表数）条策略；另需为 content 伪表落 1 条。
- 建表：新表必须为「该库所有命中 scope 的角色」补投影，否则新表对旧角色不可见（见 §7）。
- 加字段：新字段默认 `editable`，仅当该表存在显式字段配置时才需重算 mask（见 §5.4）。
- 规模：表/字段/角色很多时策略行数 = Σ(scope × 表)。当前 MVP 单工作区、数十表、十余角色量级在数百至数千行，远低于已验证的 3000 策略规模门。

### 3.3 路线 (b)：保留库级宽来源，引擎新增「窄覆盖宽」合成规则

做法：库节点保留无 mask 宽 r；在引擎/适配层对「该节点或祖先存在更窄字段授权」定义与「并集最宽」相反的新合成规则——近邻窄掩码覆盖祖先宽放行。

- 与纯 allow 模型冲突：纯 allow 的直觉是「存在一条 allow 即放行」，「窄覆盖宽」实质是在字段维引入一条隐式 deny，破坏模型一致性，需要额外解释来源。
- 与 `fieldMask.ts` 既有语义冲突：`visibleAll` / `mergeFieldMasks` / `writeOnlyFieldCapability` 全部建立在「并集只增不减」上；新增反向规则需在每个出口分叉，判定内核不再唯一，违背 `evaluate.ts` 「禁止第二份判定」。
- OVERALLOW 风险：新规则的 cutoff、邻接判定一旦有边界洞（如跨重挂载 group、继承中断、view 代理），窄规则未命中处会回落宽来源，直接越权，且这种越权不易被 shadow 布尔对拍捕获（节点级 r 仍一致，差在字段维）。

### 3.4 抉择：推荐路线 (a)

| 判据 | (a) 逐表展开 | (b) 窄覆盖宽 |
|---|---|---|
| 与第二代逐字段判定字节级一致 | 能：fieldMask 即字段裁决的物化 | 需新增反向规则，分支多 |
| 是否引入越权 | 不引入：纯 allow、只在 table 节点显式承载 | 有 OVERALLOW 边界风险 |
| 是否破坏现有 fieldMask / evaluate 语义 | 不破坏：复用全部原语 | 破坏：判定内核需分叉 |
| 写放大 / 维护成本 | 中：投影期展开 + schema 变更挂钩 | 低：库节点单条 |
| 规模适配 | 当前量级充分（已验 3000 策略） | 与规模无关但风险随复杂度升 |

**结论：采用 (a)**。理由：它是唯一能在不破坏纯 allow 与「判定内核唯一」前提下、对第二代字段裁决做到字节级一致且不引入越权的方案。写放大通过「投影期一次性展开 + schema 写点同事务补投影」收敛；规模在 MVP 量级内无压力，超量演进另立 ADR（见 §10）。

对管理员隐含授权的处理也随 (a) 一并解决：管理员（`role_admin`）对所有活库、活表的隐含可见/可写，被物化成逐表角色策略（§5.5），shadow 下不会因「无 scope 行」对管理员产生 OVERDENY；超管 `role_owner` 继续走硬短路，不需要投影。

---

## 4. scope → auth_policies 完整映射规则

### 4.1 第二代裁决的等价重述（映射的真值源）

对用户 u、库 L、表 T（kb 用 content 伪表）、字段 F：

- 有效角色集 = `effectiveRoleRows(u)`（`domain/org/authorization.js`，含部门祖先继承）。
- 超管：全权（含删库），不走投影。
- 管理员：隐含 `visible=true`、`canToggleShare=true`、`canShare=true`；管理权 `canManage` 仍只来自 scope 行；**永不持删库**。
- 其余角色：对每个 scope 行取 `visible` / `canManage` / `canShare`，多角色并集。
- 表动作 `tableAccessOf`：`canManage` → FULL（通配）；否则精确 `config.tables[T]`；否则 `visible` → 只读；否则空。
- 字段动作 `fieldAccessOf`：`config.fields[T][F]`，缺省 `editable`；该判定**独立于表动作**，即使 `canManage` 全权，`visible`/`hidden` 仍生效。

### 4.2 主体与节点定位规则

| 维度 | 规则 |
|---|---|
| subjectType | 一律 `role`；subjectId = scope 行 `roleId`（管理员隐含授权同样用 `role_admin`） |
| 库节点 | `nav/backfill.nodeId(kind, libraryId)` = `nav_base_<id>` / `nav_kb_<id>` |
| 表节点 | `nodeId("table", tableId)` = `nav_table_<id>` |
| kb content 伪表 | 直接挂在 kb 节点（无独立实体表） |
| 策略唯一键 | `auth_policies` 既有 `@@unique([nodeId, subjectType, subjectId])`：同库/同表同角色仅一行，动作并到同一行 |

### 4.3 动作在节点上的分布（关键：CRUD 与管理位分节点承载）

| 动作 | 承载节点 | 说明 |
|---|---|---|
| `r` / `c` / `u` / `d`（base 表 CRUD） | table 节点（逐表展开） | fieldMask 挂同行 |
| `r` / `c` / `u` / `d`（kb content） | kb 节点（content 伪表，一行） | fieldMask 挂同行 |
| `manage_schema` | 每个 table 节点 | 仅 `canManage=1` 时下发；表/字段/视图结构管理与「进设计器」 |
| `manage_table`（新增，见 §6） | 库节点（base/kb）【团队负责人裁决 1】 | 表元数据管理：重命名 / 删表 / 可见行配置入口；与 CRUD 分离 |
| `manage_share` | 库节点 | scope `canManage=1`（管理员隐含） |
| `comment` | table 节点 / kb 节点【团队负责人裁决 3】 | 跟随内容 `c/u/d`，只读 viewer 不给 |

> 【团队负责人裁决 1】刻意不把 `manage_table` 放 table 节点：它是「对这张表的元数据动作」，挂库节点可与逐表 CRUD、`manage_schema` 清晰分层，且不被任何 fieldMask 裁剪。命名锁定 `manage_table`，不采用 `admin_table`。
>
> 【团队负责人裁决 3】评论权保持现状：comment 跟随内容编辑（`permit().canComment = canEditData`，`guards.ts:72-74`），只读 viewer 不获评论，本期不借机放权。

### 4.4 逐表投影规则（路线 a 的核心）

对一条 scope 行（角色 R × 库 L）与库内每张活表 T：

1. **解析表动作集 A(T)**
   - `canManage=1`：A = `{r,c,u,d}` + `comment` + table 节点追加 `manage_schema`。
   - 否则：以 `visible=1` 给只读基线 `{r}`，再叠加 `config.tables[T]` 中为真的 `create/update/delete`（`read` 不扩展基线以外含义）；`comment` 仅在第二代口径成立时给——第二代 `permit().canComment = canEditData`（`guards.ts:72-74`），故 comment 跟随 `c/u/d 任一为真`，不给只读 viewer。【团队负责人裁决 3：此为现状锁定，不借机放权】
   - `visible=0 && canManage=0`：该表无策略行（`config.tables` 单独不能让表可见，第二代表读仍需库可见）。
2. **解析字段 mask M(T)**（由 `config.fields[T]`，对该表全部活字段）
   - `editable`：在 allowFields 内、不在 readOnlyFields。
   - `visible`：在 allowFields 内、在 readOnlyFields。
   - `hidden`：不在 allowFields（自然也不可写）。
   - 无任何显式字段配置：M = `null`（宽放行，读写全字段）。
3. **落一条 table 节点角色策略**：actions = 规范化(A)；fieldMask = M 序列化（M=null 则列 `null`）。
4. **mask 与写动作同源**：c/u 与 r 共用同一 M。c/u 的可写性由「在 allowFields 且不在 readOnlyFields」决定，复用 `fieldWritableInMask`；这样第二代「visible 字段只读、hidden 字段不可写」与引擎逐源判定字节一致，不并发放大。

### 4.5 canManage=1 时逐表 config 是否还投影

- 不单独投影 `config.tables[T]`：`canManage` 已使表动作全权（通配 FULL），逐表 config 在第二代号被通配覆盖，投影它只会与全权行冲突。全权基线由 §4.4-1 直接给出。
- `config.fields[T]` **仍然投影**：第二代字段判定独立于表全权，`canManage` 下 `visible`/`hidden` 字段依旧收窄。故 canManage 行的逐表策略是「全权动作 + 可能非空 mask」。

### 4.6 库级位投影规则

| scope / 身份 | 库节点动作 |
|---|---|
| `canManage=1` | `manage_table`、`manage_share`；（kb 另含 content CRUD，见 §4.3） |
| `canManage=0`，`canShare=1` 或管理员 | `manage_share`（第二代 `canShare = canManage || canShare`，管理员隐含） |
| `visible=1`（无可管/可分享位） | 库节点无管理动作；可见性由逐表 r 物化体现 |
| 删库 | **任何角色都不投影**：唯一来源超管硬短路，保证角色策略永不含删库 |

### 4.7 完整映射示例

scope：R 对 base B，`visible=1, canManage=0, canShare=0`；表 T1 无字段配置；表 T2 字段 F_a `editable`、F_b `visible`、F_c `hidden`；`config.tables[T2]={update:true}`。

- T1 table 节点（R）：actions `r`，fieldMask `null`。
- T2 table 节点（R）：actions `r,u`；fieldMask = `{"allowFields":["F_a","F_b"],"readOnlyFields":["F_b"]}`（F_c 不在 allowFields）。
- B 库节点（R）：无动作（纯只读可见）。
- 语义校验：F_a 可读可写；F_b 可读不可写；F_c 读不到也写不了；T2 可改但不可增/删；T1 只读。与第二代 `tableAccessOf` + `fieldAccessOf` 逐值一致。

---

## 5. 需要新增 / 修改的原语清单

### 5.1 新增文件：`apps/api/src/domain/authz/scopeProjection.ts`（纯函数，≤300 行）

职责：把一条 scope 行 + 活表/活字段清单展开为策略描述符；不含 IO。

```ts
export interface ProjectedPolicy {
  nodeId: string;
  subjectType: "role";
  subjectId: string;
  actions: string;                 // 已规范化存储串
  fieldMask: string | null;        // 序列化 mask，null=宽
  reason: "scope:role";
}
export interface ScopeProjectionInput {
  roleId: string;
  libraryKind: "base" | "kb";
  libraryId: string;
  canManage: number;
  visible: number;
  canShare: number;
  config: string;
}
export interface LiveSchemaShape {
  // base: 活表 id 清单；kb: 空（content 伪表直接挂 kb 节点）
  tableIds: readonly string[];
  // tableId -> 活字段 id 清单（用于 mask 全字段解析）
  fieldIdsByTable: ReadonlyMap<string, readonly string[]>;
}

export function buildFieldMask(
  tableId: string,
  liveFieldIds: readonly string[],
  fieldsConfig: Readonly<Record<string, Record<string, "editable" | "visible" | "hidden">>,
): FieldMask | null;

export function tableActions(input: ScopeProjectionInput, tableId: string): {
  actions: ResourceAction[]; manageSchema: boolean;
};

export function projectScopeRow(
  row: ScopeProjectionInput,
  shape: LiveSchemaShape,
): ProjectedPolicy[];

// 管理员隐含授权：为 role_admin 在全部活库/活表物化逐表策略与库管理位
export function projectImplicitAdmin(
  shape: { bases: LiveSchemaShape[]; kbs: Array<{ kbId: string; liveFieldIds?: readonly string[] }> },
): ProjectedPolicy[];
```

### 5.2 新增文件：`apps/api/src/domain/authz/scopeProjectionTx.ts`（事务原语，≤200 行）

```ts
// 在同一事务内，用期望投影集【精确替换】某角色（或管理员）在受影响节点的 scope:role 策略。
export async function replaceScopePoliciesTx(
  tx: DbTx,
  roleId: string,
  projected: readonly ProjectedPolicy[],
): Promise<{ upserted: number; deleted: number }>;

// 单表级联：建表/删表时为某库全部命中角色补/删该表投影。
export async function syncTableForAllScopesTx(
  tx: DbTx,
  libraryKind: "base" | "kb",
  libraryId: string,
  tableId: string | null,   // null=kb content / 删除场景
  op: "add" | "remove",
): Promise<void>;

// 字段结构变更后重算受影响表的 mask 并更新对应策略行。
export async function resyncTableMaskTx(
  tx: DbTx,
  tableId: string,
): Promise<void>;
```

实现约束：upsert 复用 `repository.upsertPolicyTx`（已支持按唯一键更新 actions/fieldMask/reason）；删除按 `nodeId + subjectType=role + subjectId` 精确 `deleteMany`，仅删 `reason='scope:role'` 行，绝不触碰 `legacy:*` 与 `policy:v1`。

### 5.3 修改：`packages/shared-types/src/authz.ts`

- 动作枚举增加 `manage_table`（见 §6.1），同步 `RESOURCE_ACTIONS`。
- 复用现有 `FieldMask` / `normalizeActions` / `toActionString`，不改其签名。

### 5.4 修改：字段 mask 重算的触发辅助

在 `scopeProjection.ts` 内实现 `buildFieldMask` 的幂等纯计算；`resyncTableMaskTx` 仅在「该表存在显式 `config.fields` 或字段集变化导致显式 mask 引用失效」时写库。新字段默认 `editable`：若原 mask 为 `null`（宽），加字段后仍宽，不重算；若存在显式 mask，新字段落入「未在 allowFields」——为与第二代「缺省 editable」一致，须把新 editable 字段补进 allowFields，故此时需重算（见 §7 加字段行）。

### 5.5 修改：`apps/api/src/domain/authz/reconcile.ts`

- 解除 C5 对 `conditions` 的一概拦截：仅当 conditions 不是 §6.3 定义的合法 RowConditions 形状时报 C5；合法形状放行。
- 新增 scope 投影对账类（只读）：以 `projectScopeRow` 为期望源，比对 `reason='scope:role'` 行的 `actions/fieldMask`，差异码建议 `S1_MISSING / S2_ACTION_MISMATCH / S3_MASK_MISMATCH / S4_ORPHAN`，供 `--apply` 复用 `replaceScopePoliciesTx` 修复。

### 5.6 修改：守卫与适配器

- `guards.ts`：新增表级管理守卫（§6.2），替换 `permit()` 中 `canManageSchema=canManage` 的绑死（`permit` 仅保留给未改造调用点，新守卫不再读它做 schema 判定）。
- `adapter.ts`：`ResourceRef.resourceType` 已含 `table`；新增把 `manage_table` / `manage_schema` 动作映射到对应库/表节点的 shadow 探针辅助（见 §8）。
- `routes/kb/shared.ts`：为 content 与 kb 管理位补 shadow 探针。

---

## 6. 表级管理位与可见行的契约设计

### 6.1 新增 ResourceAction：`manage_table`

> 【团队负责人裁决 1】命名与挂载定稿：第 8 枚动作锁定 `manage_table`，挂**库节点**；不采用 `admin_table`。

- 在现有 7 枚（r/c/u/d/comment/manage_share/manage_schema）基础上**新增第 8 枚 `manage_table`**，封闭枚举仍只增不改序；存储串继续字典序规范化（`manage_schema < manage_share < manage_table` 由字典序自然给出）。
- 语义分层：

| 位 | 回答的问题 | 节点 | 与数据 CRUD |
|---|---|---|---|
| `r/c/u/d` | 能不能读写数据行 | table | — |
| `manage_schema` | 能不能改字段/视图结构、进表单设计器 | table | 独立 |
| `manage_table` | 能不能重命名/删表/配置可见行 | 库 | 独立 |
| `manage_share` | 能不能开/关分享、建分享 | 库 | 独立 |

- 与现有 7 枚共存方式：不重定义任何旧位；旧 `requireCanManageSchema` 的接线点按语义拆分到 `manage_schema`（结构）或 `manage_table`（表元数据），不再由库 canManage 一票通放（拆分清单 §7.3）。
- 守门合法性：`policyAdmin.actionLegalForNode` 增规则——`manage_table` 仅库节点合法；`manage_schema` 维持 table/base 节点。

### 6.2 新增守卫（`apps/api/src/guards.ts`）

```ts
export async function requireTableManage(
  c: Context,
  tableId: string,
): Promise<{ userId: string; access: LibraryAccessDTO; tableNodeId: string }>;
// 判定：table 节点经祖先链对 manage_table 命中（实际挂库节点，沿链命中）。
// 用于：PATCH/DELETE /tables/:id、可见行配置写入口。

export async function requireSchemaDesign(
  c: Context,
  tableId: string,
): Promise<{ userId: string; access: LibraryAccessDTO }>;
// 判定：table 节点 manage_schema 命中。用于字段增删改、视图结构、进设计器、布局版本。
```

两者均在旧决策落定后跑 shadow 对拍（manage_table / manage_schema），off 态零新增 SQL。

### 6.3 可见行 conditions 的最小形态

存储：直接用 `auth_policies.conditions`（String，JSON），不新列、不新表。

```ts
// packages/shared-types/src/authz.ts 新增
export interface RowConditions {
  version: 1;
  // 复用既有 FilterNode 形状（filters.ts），左值仅允许字段 id；
  // 操作符白名单（最小集）：is, isNot, contains, notContains, isEmpty, isNotEmpty,
  //                         >, >=, <, <=, between, in_;
  // 支持 valueType: literal | field | dynamic(currentUser)。
  filter: FilterNode;
}
export function parseRowConditions(raw: string | null | undefined): RowConditions | null;
// 规则：非法形状 / 未识别操作符 / 非白名单值类型 -> 抛 PolicyValidationError（fail-closed）。
```

最小语义边界：
- 仅做「可见行收敛」：filter 为真的行才可见、才可被写（写入口对目标行同样求值）。
- 不做跨资源引用、不做任意 JS/表达式、不做 deny 分支；AND/OR/NOT 复用 FilterNode 组合，OR/NOT 引用不可求值字段时按 filter 既有 fail-closed 口径处理。
- 求值复用 `evalFilter`（已支持 currentUser 与字段左值），物理路径复用 queryPlan 下推；引擎不另写第二套谓词。

### 6.4 写入口与求值接线

- 写入口：扩展策略写 API。`PUT /api/v1/nodes/:id/policies` 的 upsert 项允许带 `conditions`（仅 table 节点、动作含 r 时）；`policyAdmin.parsePolicyBatch` 增 `conditions?: RowConditions` 字段并经 `parseRowConditions` 校验；`policyAdminTx` 把它随策略同事务持久化并 bump `policyVersion`。
- 读求值：`recordService.QueryOptions` 增 `rowConditions?: (filter: RowConditions) => boolean` 形态的预绑定谓词；列表在 filter 阶段叠加，详情/写入口对单行求值。谓词由路由层根据该主体在 table 节点命中策略的 conditions 构造（无 conditions 即不过滤）。
- shadow 对拍：行级 conditions 是**新能力、第二代无对应**，故不进入「布尔零差异」对拍；shadow 仅对拍节点/动作布尔维。行级正确性由 §9.4 独立用例保证。这样零差异门不被新能力污染，翻门判据保持清晰。【团队负责人裁决 4：行级不纳入布尔零差异门；须在 §9.4 全绿但不阻塞零差异判据】

---

## 7. 双写接线点全清单与触发时机

> 铁律：所有双写在既有 `withWriteTx` 事务体内、用传入 `tx` 完成；scope 行 / 投影 / `policyVersion` 共生死，任一步失败整体回滚。回调内禁止再入写队列。

### 7.1 scope 自身写点（主替换路径）

| # | 触发点 | 文件:行 | 双写动作 | 时机 |
|---|---|---|---|---|
| 1 | PUT library-scopes（整角色整体替换） | `routes/v1/org/roleLibraryScopes.ts:97-133` | scope 行落定后，对受影响库逐个 `projectScopeRow`，`replaceScopePoliciesTx` 精确替换；删除的 scope 行连同其全部投影删除 | 同事务、在 return 快照前 |
| 2 | 建库/建 KB 后 seed | 经 `libraryScopeSeed.ts:18-30`，调用点 `routes/bases.ts:189`、`routes/kb/index.ts:110` | seed 行后投影初始策略（管理员可管 + content/空表基线） | 同事务 |

### 7.2 schema 结构写点（逐表/逐字段补投影）

| # | 触发点 | 文件:行 | 双写动作 |
|---|---|---|---|
| 3 | 建表 | `routes/tables.ts:147-211`（事务体） | table 节点 upsert 后 `syncTableForAllScopesTx(...,'add')`：为该库每条命中 scope 角色补该表策略（canManage→全权、visible→r 基线 + tables 增量），随后 `syncNavFromEntitiesTx` |
| 4 | 表改名 | `routes/tables.ts:278-284` | 仅 nav name；不改投影（策略挂节点 id 不挂名），无需补投影 |
| 5 | 表软删 | `routes/tables.ts:304-320` | `softDeleteSubtreeTx` 后，该 table 节点 `scope:role` 行随节点软删语义保留（不主动删，恢复可复用）；不做物理清理 |
| 6 | 表恢复 | `routes/records.ts:934-963` | `syncNavFromEntitiesTx` 后 `syncTableForAllScopesTx` 复核，补齐恢复期间缺失投影 |
| 7 | 复制表 | `routes/tables.ts:343+` | 新表 id 走 #3 同口径补投影（源表字段 mask 不跨复制自动继承，按新 scope 配置重算） |
| 8 | 加字段 | `domain/fieldServiceTx.ts:35-82`（createSimpleFieldTx）/ `:84-156`（link 对） | 字段创建后，仅对「存在显式字段配置的表」`resyncTableMaskTx`；宽 mask 表不重算 |
| 9 | 改字段 | `fieldServiceTx.ts:158-257` | 字段结构变化（类型/关联）影响 mask 引用时 `resyncTableMaskTx`；纯改名不改 mask |
| 10 | 字段软删 | `fieldServiceTx.ts:259-302` | 从该表全部 `scope:role` 策略 mask 中剔除该字段 id（`resyncTableMaskTx` 内归一）；mask 变空则按字段配置重算为 null 或保留 |
| 11 | 字段恢复 | `routes/records.ts:890-924` | 字段复活后 `resyncTableMaskTx`，按第二代缺省 editable 补回 |
| 12 | content（kb）写点 | `domain/kbDocWrite.ts`、`routes/kb/docs.ts` | kb content 伪表策略随 scope 行投影；结构走 #3-#11 同构（content 无独立字段表，mask 来自 doc 配置） |

### 7.3 旧守卫接线点拆分（管理位解耦）

| 旧调用 | 文件:行 | 改接 |
|---|---|---|
| `requireCanManageSchema` | `routes/tables.ts:135,262,299,330`；`routes/fields.ts:104,174,238,250`；`routes/views.ts:88,210,234`；`routes/layoutVersions.ts:107` | 字段/视图/结构/进设计器/布局版本 → `requireSchemaDesign`（manage_schema，table 节点）；表重命名/删表 → `requireTableManage`（manage_table，库节点） |
| `requireCanManageBase` | `routes/records.ts:863,891,929,981,1000,1008`；`routes/bases.ts:248,424,441,473` | 清空表/回收站恢复与彻底删（表元数据）→ `requireTableManage`；库级分享与库设置仍走 `manage_share` 库守卫 |
| `requireCanToggleShare` | `routes/bases.ts:412` | 维持库 `manage_share` 守卫，语义不变 |

### 7.4 角色生命周期写点

| # | 触发点 | 文件:行 | 双写动作 |
|---|---|---|---|
| 13 | 删角色 | `domain/org/roleAdmin.ts:146-180` | 置 `deletedAt` 前：同事务删除该角色全部 `role_library_scope` 行与 `subjectType='role', subjectId=id` 的全部 auth_policy 行（含 scope:role），避免悬挂；有授予迁移逻辑保持不变 |
| 14 | 角色授予/部门继承变化 | `role_assignments` 写点（M2 已闭合） | 不直接投影（授予不产生策略），但 bump `policyVersion`，引擎下次取数即生效 |

---

## 8. shadow 对拍 → 翻门 → 回退

### 8.1 双轨对拍执行形态

- off：七守/表守卫完全走第二代，适配器不实例化、零新增 SQL（沿用现有短路）。
- shadow：旧决策为准照常返回；同上下文额外算引擎布尔（含新 manage_table / manage_schema 位，节点定位按 §4）。`runShadowCheck` → `classifyDrift`，资源反查不到活节点计 `unresolvedNode`，不计漂移；引擎抛错只记 error metric。
- on（门未翻前）：`effectiveAuthzMode` 仍降级 shadow（`configAuthz.ts:32-45`），物理响应不变。

### 8.2 翻门就绪判据（全部满足才允许翻）

1. 真实库与规模夹具上 shadow：`overDeny=0 && overAllow=0 && errors=0`，且 `compared` 覆盖七守 + 表级两新位的全部主体/动作组合。
2. scope 投影对账（§5.5 新增 S1-S4）零差异。
3. 行级 conditions 用例（§9）全绿；fail-closed 与 currentUser 口径独立验证。
4. 一键回退演练完成并计时通过。
5. 仅由项目总监下令。

### 8.3 翻门动作

- 将 `apps/api/src/configAuthz.ts:17` `AUTHZ_ENFORCE_READY` 置 `true`；生产经部署（构建 + 重启）生效，`GX_AUTHZ_ENGINE=on` 不再降级。
- on 态守卫以引擎决策为准；保留 shadow 旁路在观察期继续计数（对拍旧结果），出现非零即按 §8.4 回退。
- 沿用部署/回滚设施（systemd + 版本目录），回滚即切旧版本目录 + 配置。

### 8.4 回退开关（一键回退）

> 【团队负责人裁决 2】回退开关定稿：零迁移，用现有 `app_settings` 单键 `authz.enforce=v2scope|engine`；不新增列、不新增表。

- 优先零迁移：在现有 `app_settings` 存键 `authz.enforce=v2scope|engine`（缺省跟随 env / `AUTHZ_ENFORCE_READY`）；运行时守卫读取该键决定用第二代还是引擎，改键即切、无需重新部署。
- 兜底 env：`GX_AUTHZ_ENGINE=off` 立即回第二代（第二道兜底，与现有解析一致）。
- 回退有效性前提：`role_library_scope` 在观察期内持续双写、保持为最新真值（§7 已保证），故切回即正确，无需补数据。
- 观察期内不拆除回退开关与旧轨；退出另立 ADR。

---

## 9. 测试与验收

### 9.1 真实库等价夹具

- 建多 base / 多 kb：每 base 含若干 table，覆盖「无配置宽表、逐表增量表、字段三档混合表、canManage 全权表、content 伪表」。
- 主体：超管 / 管理员 / 自定义可管角色 / 只读角色 / 受限成员 / 无关系者；角色含 user 直授与 dept 继承两来源。
- 对每个 (主体 × 库 × 表 × 字段) 四元组，用第二代 `synthesizeAccess + tableAccessOf + fieldAccessOf` 产 brute-force 期望；shadow 下引擎布尔与 mask 必须与期望逐值相等（字段维字节级，含 readOnly/allow 集合归一化后比较）。

### 9.2 变异验证（mutation）

- 注入漂移：随机增删/翻转一条策略的动作位、mask 的 allow/readOnly 键、节点挂载层级；断言 shadow 必捕获且分类正确（OVERDENY / OVERALLOW）。
- 字段维专项：互换 editable/visible/hidden、删字段后留 mask 引用、加字段后缺省 editable，验证 `resyncTableMaskTx` 收敛且与第二代一致。
- 双写故障注入：投影步抛错 → 事务整体回滚，scope 与投影均无半截（沿用 M3/S3 同型测法）。

### 9.3 规模夹具与门

- 夹具：多库 × 多表 × 多角色，使 `Σ(scope×表)` 达到数千至上万策略行；复用 M4-S4 规模 harness。
- 断言：shadow/on 两态 P95 与 SQL 计数在既定预算内；`policiesForSubjectTx` 不受 IN 上限影响；逐表展开策略行数有界且 EXPLAIN 无异常 SCAN。

### 9.4 可见行 conditions 用例

> 【团队负责人裁决 4】行级 conditions 不进布尔零差异门，其正确性由本节独立用例兜底；下列用例须全绿（但不计入 §9.5 的 overDeny/overAllow 零差异硬门）。

- 真值矩阵：literal / field 比较 / currentUser 动态；AND/OR/NOT 组合；空值与不可求值字段 fail-closed。
- 列表、详情、写入口三处对同一 conditions 结果一致；无权行整体缺席（不置空、不暴露存在性，对齐 fieldScope 纪律）。
- 无 conditions 的表行为与 off 态逐字节一致（零变化承诺）。

### 9.5 零差异判据（翻门硬门）

- `driftRegistry.snapshot()`：`overDeny=0, overAllow=0, errors=0`；`unresolvedNode=0`（真实库应无未解析节点）。
- scope 投影对账 S1-S4 全零。
- 四门：vitest 总数随新增用例同步更新基线；api/web/shared 三包 `tsc --noEmit` 0 错；eslint 0 error；S0 golden 不回归。
- off 态零新增 SQL 硬证据（spy authPolicy delegate 调用为 0）。
- 回退演练：切键/切 env 后第二代行为逐值恢复，计时在 RTO 内。

---

## 10. 风险与遗留

| 风险 / 遗留 | 说明 | 处置 |
|---|---|---|
| 逐表展开写放大 | 策略行数随 scope×表增长；建表需为全部命中角色补投影 | MVP 量级已验证充分；建表路径同事务补全；若未来单库表/角色量级再上一个数量级，另立 ADR 评估「库级宽 r + 显式收窄表」混合投影 |
| schema 变更窗口的 mask 重算 | 加字段/删字段需归一受影响 mask，遗漏会造成字段可见性偏差 | 全部经 `resyncTableMaskTx` 单一出口；变异用例与 S3 对账兜底 |
| 管理员隐含授权的物化一致性 | 管理员宽授权靠投影体现，建库/建表漏补会 shadow OVERDENY | `projectImplicitAdmin` + #3 建表补投影；对拍覆盖管理员 |
| 行级 conditions 不进布尔对拍 | 新能力无第二代号对应，零差异门不覆盖行级 | §9.4 独立用例 + 写入口 fail-closed；文档明确其不阻塞翻门但须全绿 |
| 旧守卫调用点拆分面广 | §7.3 涉及十余处路由 | 纯守卫替换、行为以 shadow 对拍锁定；分文件小步提交 |
| 旧轨退出 | `role_library_scope` 与 legacy:* 投影保留 | 本切片不摘；稳定观察期后另立 ADR 再议物理退出 |
| 非本次历史遗留 | tables 路由拆分、分享访客问题等 | 不并入，避免范围膨胀 |

---

## 附：实施顺序建议（切片内）

1. shared-types 增 `manage_table` + RowConditions 类型与 parse。
2. `scopeProjection.ts` 纯函数 + 单测（mask、actions、逐表展开、管理员隐含）。
3. `scopeProjectionTx.ts` 事务原语 + 双写故障/幂等测。
4. 接 #1 PUT library-scopes 与 #2 seed 主路径，shadow 对拍现有库归零。
5. 新守卫 `requireTableManage` / `requireSchemaDesign` + §7.3 拆分接线。
6. schema 写点 #3-#12 全接线。
7. 行级 conditions 写入口/求值。
8. reconcile 增 scope 对账 + 规模夹具。
9. 四门 + 零差异门 + 回退演练，送终审后由总监下令翻门。
