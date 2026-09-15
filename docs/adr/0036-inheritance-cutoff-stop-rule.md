# ADR-0036：继承中断的 cutoff 停止规则（非简单布尔）

**状态（Status）**：Accepted（裁决 A-6 体系与 §4.5 EARS 随 M4 计划终审通过；2026-09-16 M4 出口归档）
**作者**：后端 贝洛奇
**上游依据**：M4-implementation-plan.md §0-5、§4.5（cutoff 公式与 EARS）、§7-S7；PRD O6；AC-M4-2
**关联**：ADR-0032（cutoff 内纯 allow 收集）；ADR-0038（私密子树在 scope 中的应用层裁剪）；ADR-0035（面包屑与树剪枝同读就绪门）

---

## 1. 背景（Context）

M3 把 `nav_nodes.inheritAncestors` 列恒置 1（全树继承）。M4 开放该列作为
"中断继承"开关，仅 doc/canvas 内容叶子可关。若把它简单实现成布尔短路
（节点 K 关闭后，K 及其全部后代不继承任何祖先），会同时误伤两件事：

1. K 自身的策略不应被自己的开关屏蔽——给 K 直挂或经 K 授予的权限必须仍然
   生效，否则管理员无法在 restricted 边界节点上做精确授权；
2. 后代节点收集祖先授予时应在 K 处**停止上溯**，但 K 本身是"被允许的最后
   一个祖先边界"，K 上的策略仍须被后代收集。

"父无权、子 direct 有权"（裁决 A-6）还要求 restricted 不影响直挂授予与
creator/owner 兜底。故 cutoff 是链收集的停止规则，不是权限的总开关。

## 2. 决策（Decision）

### 2.1 链收集规则（collectibleChainIndexes，nodes.ts:35）

chain[0] 为被决策节点自身，其后自近及远为祖先：

1. 自身恒收集；
2. 自身 inheritAncestors=0 时，只收集自身；
3. 否则向上收集直到遇到第一个 inheritAncestors=0 的祖先 K：**收集 K 后
   停止**（含 K，不含 K 之上）。

由此得到三条边界语义（s10-ac-cutoff-grandchild 端到端锁定）：

- **K 保护自身**：仅被授 K 节点的用户，对 K 本身有权（直挂不受开关影响）。
- **K 的策略及于子孙**：该用户对 K 下 inherit=1 的子 C、孙 G 仍可见——
  C/G 的链收集都含 K。
- **子孙链在 K 截断**：仅被授 kb 容器的用户，对 restricted 子树 K/C/G
  全部不可见（链止于 K，kb 不被收集），但同一用户对库外普通文档的访问
  不被一刀切（库外文档链不经过 K）。

### 2.2 impact 三源去重展开

关继承预览（inheritance.ts inheritanceImpact）：

- V_now = 当前 cutoff 链上含 r 的三源授予展开的 ACTIVE 用户集；
  V_after = 仅节点自身授予展开，加资源 creator 与 workspace owner 兜底；
  losing = ACTIVE(V_now) - ACTIVE(V_after)。
- 三源反向展开复用 GrantExpander：direct 为直授用户；role 经
  usersWithRole 同口径（user 直授加授予部门子树成员，仅 ACTIVE）；dept 为
  被授部门子树全体活部门成员。多部门/多角色只计 1（userId 去重）；
  count 精确（全量展开后去重），items 按 userId 字典序分页（默认 100，
  上限 200）。
- creator/workspace owner 从 losing 剔除并列入 exempt（仅当其关后靠兜底
  才不失访）；人数不含行级谓词（A-7，M4 无行权限）。
- 重开方向对称：gaining 只算授予侧新覆盖的用户，creator/owner 关继承期间
  本就有兜底访问，不算"恢复"，exempt 恒空。

### 2.3 二次确认 EARS

- 仅 doc/canvas 可切换：其他 kind 返回 400 NODE_NOT_INHERITABLE；
  软删/不存在节点 404。
- PATCH 未带 `confirmed:true`：409 INHERITANCE_CONFIRM_REQUIRED + 完整
  impact 载荷，状态不变；带确认后写 inheritAncestors、bump navVersion
  （结构变）与 policyVersion（决策输入变）、审计前后 diff。
- 幂等：目标值与现值相同不 bump（s7-inheritance 锁定）。
- 关后同库其他 doc（不在 K 子树）继承访问不受影响；restricted + direct
  放行，移除 direct 下次请求即 403（无决策正缓存，ADR 见 policyVersion
  即时性）。

### 2.4 三通道表现（A-6）

关继承后，对仅靠 kb/祖先授予的用户：tree 无该子树位置（不造伪父链）；
menu shortcut 被剪；但持直达 URL 或被保留 shortcut 的用户能打开内容
（直挂授予/creator/owner 在）。打开后面包屑从该用户**有权的最高祖先**
起渲染，无权祖先段中性截断，链首坐标重写（不泄漏无权节点 id/name/path
与深度，breadcrumb.ts:67-76）。

## 3. 被否决的备选

1. **布尔全短路（K 关 = K 及子孙不收任何策略含 K 自身）**：使 K 上的
   管理授予失效，无法表达"边界节点受控开放"，与"K 保护自身"冲突。
2. **K 关只挡直接父、不挡更高祖先**（只断一条边）：kb 授予仍会跨过 K
   生效，中断继承没有实际 secrecy 效果。
3. **impact 只按 kb_members 粗算**：M4 三源（direct/role/dept）下漏算
   角色与部门授予人数；定稿三源展开且与 decide/scope 同口径（impactExpand
   复用同一批纯函数），人数可与逐节点判定对拍。
4. **不做二次确认直接写**：误操作瞬间切断访问；EARS 409 门 + 精确人数
   预览是硬要求（PRD O6/AC-M4-2）。

## 4. 后果（Consequences）

- restricted 子树的裁剪在 decide/scope 中天然成立，无需 SQL 递归差集
  （scope 全量取节点后用同一 cutoff 纯函数逐节点判，ADR-0038）。
- 重开只需一次 PATCH：inheritAncestors 置回 1，被拦的祖先授予即刻恢复，
  数据无损；旧守卫不读该列，回滚引擎后该列行不影响旧表决策。
- 表/view/group 不能设私密（400），企业级库/表级隔离需用直挂或角色
  授予正向表达，不能借"关继承"。

## 5. 验证证据

- 停止规则纯函数：nodes.ts collectibleChainIndexes；cutoff.test.ts
  （全分支表驱动）。
- EARS/豁免/对称：`__tests__/s7-inheritance.test.ts`（14 例）。
- 孙节点端到端：`__tests__/s10-ac-cutoff-grandchild.test.ts`
  （kb->K(restricted)->C->G 两条规则 + 库外文档不连坐）。
- impact 三源与 move-impact：s7-move-impact、21cd963 中 willBreak
  InheritanceHint 真值。
- 面包屑/树剪枝字节级中性截断：s7-prune.test.ts、breadcrumb 相关用例。
- 落地 commit：21cd963（S7）、63f7020（S10 AC）。
