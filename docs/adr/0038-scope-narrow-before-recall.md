# ADR-0038：M5 先收敛后召回的 scope 契约（两形态）

**状态（Status）**：Accepted（M4 计划 §0-7/§4.7 定稿；scope 接口本身已随 M4-S4 落地并过规模门，召回侧约定移交 M5；2026-09-16 M4 出口归档）
**作者**：后端 贝洛奇
**上游依据**：M4-implementation-plan.md §0-7、§4.7（接口契约与消费纪律）；AC-M5-2（零泄漏的工程定义）；spike-sqlite-vec 结论
**关联**：ADR-0032（scope 与 decide 共用 evaluateChainDecision）；ADR-0035（maskedTableFields 供 M5 字段剔除）；ADR-0037（visible-scope 端点不经三态 flag）

---

## 1. 背景（Context）

M5 向量库与统一检索、M6 鉴权 MCP 都需要一个问题的答案："这个用户能看到
哪些资源？"若由各召回通道（向量/FTS/标签）各自实现可见性，就会出现先把全库
召回再在应用层过滤的反模式——无权数据已经离开 search.db、进入排序与摘要
管线，既慢又容易从日志/缓存侧漏。M4 必须在不接检索路由的前提下，把可见集
的计算与消费契约冻结，让 M5 在召回前完成收敛。

## 2. 决策（Decision）

### 2.1 唯一入口与零分叉

统一入口 `resolveVisibleNodeIds(userId, opts)`（domain/authz/scope.ts），
对全量活节点复用与单节点 decide **完全相同**的判定内核
evaluateChainDecision（同一 cutoff、两类 owner 兜底、动作命中、字段维），
不另写一套"G 并子树减 restricted"近似集合运算。restricted 子树裁剪因此
天然成立：子节点链在 cutoff 边界停止收集，K 自身无授予且其下无直接 allow
即不在可见集，无需 SQL 递归差集。

### 2.2 两形态输出（scopeSql.ts）

调用方按可见集规模选择形态：

1. **id 集 budget**：nodeIds（确定性 path,id 排序）、按资源类型归集的
   resourceIdsByType、policyVersion、evaluated/visibleTotal 诊断计数。
   默认 budget 5000，硬上限 20000（clampBudget），超出 truncated=true。
2. **参数化 SQL 片段**：buildVisibleScopeSql 产出占位符串（如 "?,?,?"）
   与有序 params（全部绑定参数，零字符串内插，杜绝注入）；
   nodeIds 为 0 时 sql=""（消费方按空集/永假片段 EMPTY_SCOPE_PREDICATE
   "1=0" 处理）；1..499 个给单批 IN；**>499 或 truncated 时
   expectsTempTable=true、sql=""**——M5 必须把 id 集物化为 search.db
   ATTACH 临时表后 JOIN 收敛，禁止超长 IN 直拼（SQLite 默认 999 变量
   上限，499 留余量，SCOPE_IN_BATCH=499）。

### 2.3 M5 消费纪律（冻结给 M5 的硬约束）

1. 召回前先把 scope 物化为临时表或分批 IN（每批 <=499），向量/FTS 候选
   必须 JOIN 收敛，**禁止先召回全量再应用过滤**——这就是 AC-M5-2
   "零泄漏"的工程定义：无权 id 不进入向量/FTS 召回。
2. 集合运算上移应用层：G（命中授予节点）与子树展开、cutoff 裁剪不在
   SQLite 做 CTE 递归（万级集合 JS Set 运算毫秒级，计划 §4.7），SQL 侧
   只用前缀索引（nav path LIKE、主体复合索引）。
3. 字段侧交付 `maskedTableFields: {tableNodeId: string[]}`——仅列该用户
   有掩码的表（仅 r 动作产出；默认空对象不膨胀），M5 对命中文档摘要的
   字段按此剔除；派生库无法逐用户建字段索引，字段可见性不进召回侧索引。
4. 动作集默认 ['r']，多动作取并（节点对任一动作可见即纳入）；kinds
   白名单七类（base/kb/table/view/doc/canvas/group），非法动作 token
   fail-closed 抛错（不静默 normalize 丢弃后返回过宽集合）。

### 2.4 规模上界证据（M4 已测，M5 在此上界内设计）

- 客体批量往返定数：非 owner 恰 4 条 SQL（三源候选策略一次 OR 取、全量
  活节点一次取、creator UNION ALL 一条、workspace 版本点查），owner 跳过
  creator 为 3 条；与节点数/部门深度无关。主体解析 resolveSubject 另计
  定数 <=4（复用 M2 effectiveRoleRows）。
- 500 用户/31 部门（6 层）/10000 节点/约 3000 策略夹具：单用户 scope
  万节点全量内存判定 P95 41.8-44.0ms；同夹具 decide 冷决策 P95
  0.36-0.41ms（n=252），同版本链缓存命中仅 1 条策略 SQL。
- 12 抽样用户 x 500 节点 x r/u 两动作 = 12000 次 scope 与 decide 布尔
  对拍 0 差异；EXPLAIN scope 四物理 SQL 与 decide 四物理 SQL 全 SEARCH
  INDEX，零裸 SCAN（creator 四表索引由迁移 20260916120000 建）。

## 3. 被否决的备选

1. **先召回后过滤**：无权数据进入召回与摘要管线，慢且无法防侧信道；
   AC-M5-2 明确禁止。
2. **SQL CTE 递归算可见集**：SQLite CTE 表达 cutoff 与三源展开复杂、
   难与 decide 保持同口径（两处判定必然漂移）；应用层复用同一纯函数
   结构性消灭分叉。
3. **超长 IN 直拼**：撞 999 变量上限且无法防注入；超 499 一律临时表。
4. **M5 各自实现权限过滤**：M6 MCP 同样要消费可见集，多入口等于多套
   语义；定稿单一入口两形态。

## 4. 后果（Consequences）

- M4 交付的是接口/契约/规模证据，不挂任何检索路由（探针端点
  GET /api/v1/authz/visible-scope 仅供 M5/M6 联调，manage_share 或本人）。
- 超大客户（可见节点 >20000）召回必须走临时表分支；M5 实施时需要在
  search.db 的 ATTACH 生命周期与临时表清理上给出设计（M4 不预设）。
- scope 响应随 policyVersion 回传；消费方可在写后凭版本判断是否重算，
  但 M4 不做跨请求缓存承诺（与 M2 即时性纪律一致）。

## 5. 验证证据

- 实现：scope.ts（204 行）、scopeSql.ts、scopeCreators.ts；测试
  scope-pure、scope-parity（含 prepareScope 原语一致性、cutoff/kb 继承/
  budget 截断转 temp table）、scope-scale（门控）、s10-scale-gate。
- 规模数据：docs/baseline/2026-09-16-m4-gate.md §1（双 P95、SQL 定数、
  12000 对拍、EXPLAIN 全 INDEX）。
- 端点契约：routes/v1/scope.ts、docs/api/openapi.yaml VisibleScope 13 键、
  s9-dto-openapi-cross 第 7 例。
- 落地 commit：6047991（S4）、a4e1f50（S10 规模门）。
