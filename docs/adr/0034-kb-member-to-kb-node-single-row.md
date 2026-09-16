# ADR-0034：kb_members 映射到 kb 节点单行，不逐 doc 物化

**状态（Status）**：Accepted（裁决 A-1 由项目总监 2026-09-16 批准，覆盖 ARCH-enterprise §6.2 逐 doc 物化草案；2026-09-16 M4 出口归档）
**作者**：后端 贝洛奇
**上游依据**：M4-implementation-plan.md §0-3、§5.2-2、§5.3、§10 裁决 A-1；ARCH-enterprise §6.2（被覆盖草案，:600 附近）
**关联**：ADR-0033（旧表投影总策略）；ADR-0032（祖树继承是纯 allow 并集）；ADR-0036（cutoff 边界下 kb 授予不下 restricted 子树）

---

## 1. 背景（Context）

ARCH §6.2 草案要求：每个 `kb_members` 行对该知识库下的**每个** doc/canvas
节点都在 auth_policies 写一行直挂策略。1000 成员 x 1000 文档 = 100 万行，
而 nav 祖先链继承本来就是引擎的一等能力（成员对 kb 节点的授予沿物化路径
天然荫及全部后代 doc/canvas）。逐 doc 拷贝是冗余，更严重的是它必然制造
不一致窗口：新建文档的瞬间，kb_members 已有的成员授权还没来得及逐行复制，
两个系统在该文档上判定不同。

## 2. 决策（Decision）

1. `kb_members` 活行只投影到 **kb 容器节点一行** user allow
   （reason=`legacy:kb_member`）；回填 SQL 的 kb 段只 JOIN nav_nodes 取
   kb 节点，段内不出现 kb_docs（backfill-literals 测试以 SQL 文本断言锁死）。
2. kb 下 doc/canvas 的访问由引擎沿 nav 祖先链收集 kb 节点策略获得，
   与成员旧守卫"kb 成员可访问库内全部内容"的语义同口径。
3. `kb_doc_acls` 仍逐行映射到具体 doc/canvas 节点（这是真正的单内容例外，
   承载 viewer/commenter/editor 的逐文档收窄）。
4. members 同理投影到 base 节点一行，table/view 经祖树继承覆盖。
5. 量化：1000 成员 x 1000 文档场景，投影行数从约 100 万降到 1000 行
   （kb 容器）加稀疏 ACL 行，省 99.9 万行。

## 3. 证伪判定标准（裁决要求的可执行断言）

本节原文收录裁决 A-1 的回退条件，作为本决策的存活条件：

> 对任一 kb_member（kb=K，user=U）与其下任意 N 层（夹具深度 N>=4）的每个
> doc/canvas 节点 D，引擎判定 `decide(U, D, x)`（x 取
> {r,c,u,d,comment} 动作全集）必须与"D 上存在直挂 user allow 同动作行"
> 的假想逐 doc 物化判定**逐文档、逐动作等价**。任一 (U,D,action) 不等价
> 即 A-1 证伪，回退 ARCH §6.2 逐 doc 物化，本 ADR 顶部状态改为 Superseded
> 并加 Superseded by 链接，回填行数与对账 A 类预期同步修订。

**M4 实际代码化情况（存活断言已代码化，常规即跑）**：

- 存活断言已代码化于 `s11-kb-single-row-equiv.test.ts`（M4/S11 补丁）：
  建一棵 kb > doc 容器链（nav depth 含 kb 根，最深叶 depth=6，相对 kb
  实打实下钻 5 层，满足裁决 N>=4），含 9 doc + 1 canvas 共 10 个内容叶，
  depth 2..6 每层至少 1 叶（canvas 因 backfill.ts:78-81 仅能挂 kb，以
  depth2 叶覆盖第二种 kind）。viewer/editor 两档 kb_member 经生产回填
  路径投影到 kb 容器单行；同一棵树同一批用户物理切换到"每个内容节点各
  写一行 direct 策略"的假想逐 doc 物化形态，两态对全部内容叶逐动作跑
  引擎 decide（r/c/u/d/comment/manage_share 六枚，manage_schema 对
  doc/canvas 非法不取），**2 成员 x 10 叶 x 6 动作 = 120 格逐格全等**。
  另锁：非成员对照用户 10 叶 x 6 动作全 deny；一个仅对最深 doc 持 direct
  `kb_doc_acls`（editor 档）的例外用户只在该叶拿五动作、其余 9 叶全 deny。
- 该断言是有效存活断言而非恒真：测试内含切断继承 sanity（把中间容器
  inheritAncestors 置 0，深层叶 r/comment 立即转 deny、库直挂叶不受影响，
  随后还原），且开发期以变异自证——把逐 doc 物化态 editor 动作串去掉
  comment 后全等用例如期报出 10 个分叉格（提交态已还原全绿）。未来若
  单行继承与逐 doc 物化真分叉，本文件变红。
- 回填形态与无膨胀断言：`backfill-literals.test.ts` 锁"kb_members 只投影
  kb 容器一行（段内不 JOIN kb_docs）"；`backfill-reconcile.test.ts:131`
  锁 doc/canvas 无成员投影膨胀。
- 同判定内核的旁证仍保留：`scope-parity.test.ts`（kb 容器授 r、doc/canvas
  子节点继承）、`query-count.test.ts`（7 层 nav 链深度不增判定）、
  `s10-ac-cutoff-grandchild.test.ts`（kb->K(restricted)->C->G cutoff
  端到端）、`s10-ac-upgrade-20x20.test.ts`（400 格升级等价）。
- 回退动作仍以本节标准为准：未来任一版本出现反例（本夹具或其他场景），
  即按裁决回退逐 doc 物化并 Superseded 本 ADR，不得以"测试没覆盖"为由
  保留单行方案。

## 4. 被否决的备选

1. **ARCH §6.2 逐 doc 物化**：百万行冗余；新文档瞬间两系统不一致；ACL
   已能表达逐文档例外，成员级库授权没有逐行复制的必要。
2. **逐 doc 物化但异步补行**：用任务队列追赶新文档，引入最终一致窗口与
   队列故障面，而引擎本可同步走祖树，属于为不存在的问题付费。
3. **kb_members 投影到 kb 行但额外缓存展开结果**：祖树收集已是 path IN
   一次取全链的定数查询（query-count 锁定客体 3 条 SQL），无需展开缓存。

## 5. 后果（Consequences）

- 投影规模与成员数线性相关，与文档数解耦；reconcile 期望集小、可全量跑。
- kb 成员变更只动 kb 节点一行（精确 SET），不扇出到全部文档。
- 边界语义由 cutoff 承担：库内某文档关继承（inheritAncestors=0）后，
  kb 成员授予在该子树截断（ADR-0036），这与旧系统无 cutoff 能力相比是
  **新能力收窄**，不是回归——旧系统无中断继承功能，该路径不存在旧行为。
- 若 P1 深树专项证伪，回退成本为：回填 SQL 加 kb_docs JOIN 段、reconcile
  期望集改逐 doc、行数预期与对账文档修订；引擎与表结构不用改。

## 6. 验证证据

- 回填 SQL 形态：`__tests__/backfill-literals.test.ts` kb 段断言（NOT
  contain kb_docs）、三前缀与确定性 id 断言。
- 无膨胀：`__tests__/backfill-reconcile.test.ts` doc/canvas 无成员投影。
- 存活断言（N>=4 专项）：`__tests__/s11-kb-single-row-equiv.test.ts`
  10 叶 x 2 成员 x 6 动作 = 120 格单行/逐 doc 物化全等 + 非成员全 deny
  + ACL 例外单叶 allow + 切断继承 sanity（变异自证会变红）。
- 继承等价旁证：`__tests__/scope-parity.test.ts` kv 用例；
  `__tests__/s10-ac-cutoff-grandchild.test.ts`；
  `__tests__/s10-ac-upgrade-20x20.test.ts`。
- 深度无关：`__tests__/query-count.test.ts` 7 层链客体 SQL=3。
- 落地 commit：aa8c28c（S2 迁移与对账）、d1d7ac6（S1 纯函数层）、
  6047991（S4 scope）、63f7020（S10 AC）；N>=4 存活断言随 M4/S11 出口
  补丁切片（test(m4-s11)）与本文件证伪段更新一同落地。
