# ADR-0035：fieldMask 挂 table 策略行，不建 field 节点

**状态（Status）**：Accepted（M3 ADR-0031 不建 field 节点的下游定稿；裁决 A-4 最小泄漏两档 2026-09-18 批准；2026-09-16 M4 出口归档）
**作者**：后端 贝洛奇
**上游依据**：M4-implementation-plan.md §0-4、§1.3（五出口）、§4.3/§4.4；M3 裁决 3（field 不建 nav 节点）；裁决 A-4
**关联**：ADR-0032（fieldMask 是命中 allow 之上的能力收窄，不是 deny）；ADR-0033（v1 mask 策略不可映射回旧表）；ADR-0040（legacyUnmappable）

---

## 1. 动态（Context）

M3 已定不为动态字段建 nav 节点（字段是表内 EAV/sidecar 数据，生命周期与表行
而非导航实体一致）。M4 要做字段级可见/只读，落点只能是策略行上的一个 JSON 列
`fieldMask`（M3 冻结的 auth_policies 结构已含该列），而不是新建 field 客体
再挂策略。关键语义风险是"隐藏"的表达方式：mask 不能变成事实上的 deny 清单，
否则与纯 allow 模型（ADR-0032）冲突。

## 2. 决策（Decision）

### 2.1 数据形态与收窄语义

- fieldMask 形状 `{allowFields?: string[], readOnlyFields?: string[]}`，
  挂在 **table 节点**的策略行；**缺省/null = 不裁剪**（全字段），因此它是
  命中 allow 之上的收窄清单，不是授权清单。
- 单源判定（fieldMask.ts）：可见要求字段在该源 allowFields 内（allowFields
  缺省视为全字段）；可写要求先可见且不在该源 readOnlyFields 内。
- 多源并集**取最宽**：可见 = 任一 r 来源可见之并；任一来源不裁剪则全字段
  可见；可写 = 任一 c/u 来源在该源下可见且非只读。readOnlyFields 是该来源
  的能力裁剪不是 deny，另一来源给可写则最终可写。
- 写键守卫整单拒绝：payload 出现不可见或只读字段键，403 FORBIDDEN_FIELD
  整单回，事务不开，不静默丢弃（assertFieldsWritable）。
- 仅 table 节点接受 fieldMask（validateBatch 校验字段全部属于该 table 活
  字段），其他节点携带 mask 整单 400 POLICY_FIELD_INVALID。

### 2.2 五出口单一投影

字段不可见必须在五个出口一致缺席，五出口共用 fieldMask.ts 的纯函数，不各写
一份过滤：

1. 记录列表（records 列表响应：逐行 fields 删键 + fields/allFields/groups/
   aggregations 过滤）；
2. 记录详情（hydrate 单条同口径）；
3. 记录写 payload（事务前键白名单 403）；
4. CSV 导出（列集 = 可见字段交集）；
5. hydrate 内关联标题/公式依赖（依赖列照常参与服务端计算但不下发原值）。

另有视图配置脱敏（sanitizeViewConfigForMask）：filters/sorts/aggregations/
groupBy 中引用隐藏字段的部分抹除，物理 compile 与内存 applyViewQuery 共用
同一份脱敏配置，隐藏列不能用于偷偷过滤/排序/分组/聚合。

### 2.3 裁决 A-4：最小泄漏两档

针对 LinkRef（关联显示值）泄漏面：

- **第一档（表可见 + 展示字段被 mask）**：主体对目标表有表级 r，但被引用
  记录的展示字段在其 mask 内。LinkRef title 回退为**真实 recordId**（非空、
  非伪造），旁注用统一中性文案（前端片定稿，不出现"无权限"字样——该措辞
  对无权者反证字段存在）；悬浮解释只对这类用户出现。
- **第二档（表级完全不可见）**：该引用整体走不可见通道，LinkRef **不出现在
  下发数组中**，无 id、无 title、无 tableId（不是 `[{recordId:...}]` 占位）。
- 旧兜底串 `"(无标题)"` 在 on 态被上述策略替换；owner/无 mask 视角行为不变。

### 2.4 mask-null 与真空值不可区分

隐藏字段参与公式求值时以 **null** 注入，且注入的 null 与该字段真实空值
**逐字节不可区分**：同一记录在"真空值"与"有值但对该用户 mask"两态下，
全部下游公式结果与错误文案一致。空值探测函数因此同口径生效——引擎中的
判空函数是 **ISNULL**（domain/formula.ts:597-598，命中返回布尔），mask
注入 null 会使 ISNULL=true，这是不可区分原则的必然推论，不得为 mask 单开
分支或返回特殊错误文案。另有 BLANK()（formula.ts:599-600 附近）返回 FNULL，
与判空无关；本 ADR 按 ISNULL 记名，后续文档提到判空函数时只允许使用
ISNULL 这一名称，不得使用其他电子表格风格的误名。

### 2.5 门控

fieldMask 五出口有独立就绪门 `FIELD_MASK_ENFORCE_READY=true`，读**原始**
GX_AUTHZ_ENGINE（不经 on->shadow 降级）：env=on 时字段投影/写键校验/物理
下推即生效，即便七守资源可达性仍在 shadow；off/shadow 五出口短路，与
M3/M4-S0 金标准逐字节一致。只减不增（先过旧守表级 r 再做字段维收窄），
因此全局 enforce 未翻也不产生越权放行。

## 3. 被否决的备选

1. **为每个字段建 nav 节点挂策略**：与 M3 ADR-0031 冲突，节点数随表结构
   爆炸，字段删除/新建要维护客体生命周期。
2. **denyFields 清单**：变回 deny 模型，多源合并要回答"个人 allow/部门
   deny 谁赢"，与纯 allow 并集不可兼得。
3. **隐藏值返回伪造空串/0**：伪造标量会进入公式、汇总、导出造成静默数据
   错误；选定真实 null 注入并保证与真空值不可区分。
4. **LinkRef 对无权者显示"无权限"**：反证字段/记录存在，属侧信道，禁止。

## 4. 后果（Consequences）

- 字段能力随策略行自然支持 user/dept/role 三源与祖先继承（表节点上的
  mask 随链收集），无需额外机制。
- 管理员要收窄必须改**宽来源本身**：宽来源（无 allowFields）与窄来源并存
  时最终全字段可见，这是并集最宽原则的直接推论，面板需向用户明示
  （M4-FE 责任）。
- 计算字段依赖隐藏列时服务端仍取数计算，只是结果可见性按结果字段自身的
  mask 决定；M5 统一检索消费 scope 的 maskedTableFields 做摘要剔除。
- 写键整单拒绝（不丢键）可能让习惯"部分更新"的客户端收到 403，这是
  有意的 fail-closed 姿态。

## 5. 验证证据

- 纯函数：`domain/authz/fieldMask.ts`（fieldVisibleInMask:31、
  fieldCapability:62、canWriteField:100、applyMaskToRecords:143、
  assertFieldsWritable:165、sanitizeViewConfigForMask:195）。
- 五出口与字节一致：`__tests__/s6-mask-exits.test.ts`、s6-mask-sanitize、
  `__tests__/s6-a4-special.test.ts`（两档：title===recordId、表不可见时
  refs=[]）。
- null 不可区分：s6-a4-special 含真空值 vs mask null 公式结果字节一致断言。
- AC-M4-3 六通道 + M1 flags 四组合：M4 RC-51（regression-cases H 组）与
  s10-ac-authz-matrix 越权直调。
- 落地 commit：80ed676（S6）；门常量 configAuthz.ts:64。
