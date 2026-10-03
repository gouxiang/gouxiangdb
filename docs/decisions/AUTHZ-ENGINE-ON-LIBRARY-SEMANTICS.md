# AUTHZ-ENGINE-ON-LIBRARY-SEMANTICS

- 状态: Accepted（2026-10-03 架构师 arch-authz-on-final 定稿；2026-10-03 按落地实况校订，见 §0.1）
- 范围: 构想工作台新权限引擎 M4，三态由 `GX_AUTHZ_ENGINE(off|shadow|on)` + 硬门 `AUTHZ_ENFORCE_READY` 控制。当前生产 `off`，本设计是翻 `AUTHZ_ENFORCE_READY` 前最后一个阻断缺陷的唯一修法。
- 性质: 纯设计。只读代码、只写本文档；不改任何生产码、不提交代码。
- 关联: `docs/decisions/AUTHZ-LEGACY-GUARD-CLEANUP.md`、`docs/runbooks/authz-engine-flip-on.md`，M4 implementation plan，代码内以 `ADR-0056` 编号引用本裁决。

---

## 0. 一句话裁决

**采用「库级可见性一等动作位 `enter` + 库内活表可写并集一等动作位 `edit_data`，两枚聚合位都投影到库节点、由同一引擎内核在库节点上判定」的方案；否决「库节点补 `r`」与「判定层实时跑库内活表并集但沿用 `r`」两条修法。**

理由：当前引擎拿「节点 `r`」同时兼职表达两件本应分开的事——「人能不能进这个库」（库级、纯准入、与表无关）与「人能不能读这张表的内容」（表级、须承载 fieldMask 收窄）。兼职导致两条直觉修法各自撞一条已验收语义（详见 §1）。本方案把这两个概念在动作词汇层拆开，并把它们都做成**由窄策略投影派生、落在库节点自身**的一等动作位：

- `enter` 表达库级准入（= legacy `access.visible`）；
- `edit_data` 表达库内活表可写并集（= legacy `perm.canEditData` = `canManage` 或任一活表被授 c/u/d）；
- 表级内容读仍由 table 节点的 `r` + fieldMask 承载。

两枚聚合位都不是 r/c/u，结构上不可能进入 fieldMask 能力并集；守卫与 visible-scope 探针判的是同一枚位、同一个内核，零分叉；位由投影直接落在库节点，不依赖判定时库内是否还有活表，空库成立。

### 0.1 本次校订相对初稿的差异（落地实况反推）

初稿提出「单次 prepareScope + 新增 `libraryDecide.ts` 在请求内存里逐表 OR」。落地切片把它进一步简化、且不削弱任何一条约束：**把「可写并集」也做成投影派生的一等动作位 `edit_data`，与 `enter` 一起落到库节点策略行**。于是 on 态七守不再需要任何「节点集合内存聚合」——对库节点判一枚位即可，全部走现有 `decide` 单节点路径。差异清单：

| 维度 | 初稿 | 落地（以本稿为准） |
| --- | --- | --- |
| 聚合位数量 | 仅新增 `enter`，写/评论另走内存 OR | 新增两枚：`enter` + `edit_data` |
| 写并集求值位置 | 请求内 `prepareScope` + `libraryDecide.libraryWriteAllowed` 内存 OR | 投影期就算好并集，写进库节点 `edit_data`；判定期只判该位 |
| 新增文件 | `libraryDecide.ts` | 不新增；复用 `scopeProjection.ts` / `implicitAdminProject.ts` + 引擎 `decide` |
| 枚举长度/顺序 | 8→9，`enter` 置首位 | 8→10，`enter`、`edit_data` 追加在末两位（见 §2.1） |
| reachability 体检信号 | `libraryUnreachable` | 已废弃，改为聚合位等价对拍 `mismatches`（见 §4.5） |

三约束 (a) 不进 fieldMask 并集 / (b) 与探针同口径 / (c) 不依赖活表 全部保持，且实现更小。

---

## 1. 缺陷定性与两条死路的根因

### 1.1 已逐行核实的代码事实

| 事实 | 落点 |
| --- | --- |
| 七守统一走 `enforceBase()`，ref 恒为 `{ resourceType:"base", resourceId:baseId }` | `apps/api/src/guards.ts:104-121` |
| 数据动作 r/c/u/d/comment 只投影到 table 节点；库节点只放管理位 + 两枚聚合位 | `scopeProjection.ts:174-196`（projectBase）、`:143-155`（聚合/管理位） |
| 库可见逐表展开为窄策略是刻意设计，避免库节点宽授权经祖先继承淹没逐表/逐字段收窄 | `scopeProjection.ts:1-7` 文件头 |
| `enter` 由 visible/canManage 派生，零表库也 emit；`edit_data` 由 canManage 或任一活表可写派生 | `scopeProjection.ts:118-147` |
| kb 分支把 content 动作、管理位与 `enter` 合并到单条 kb 节点；kb 不 emit `edit_data` | `scopeProjection.ts:202-209` |
| 管理员隐含投影：库节点恒推 `manage_share` + `enter`，canManage 时补 manage_table/manage_schema/edit_data；库节点无内容 r | `implicitAdminProject.ts:68-73`、`:87-89` |
| 判定三档：creator → workspace owner → 动作命中策略；落空即 deny | `evaluate.ts:96-109` |
| 第二代 legacy 管理员分支强制 visible/canToggleShare/canShare=true，但不强制 canManage | `libraryPolicy.ts:137-140` |
| enforceGate：off 零 IO 返回 legacy；shadow 返回 legacy + 正向对拍；on 走引擎判单节点，nodeId 缺失 fail-closed，引擎抛错回落 legacy | `enforceGate.ts:75-119` |
| fieldCapability 只按 r/c/u 收集来源；`enter`/`edit_data` 结构上进不了能力并集 | `fieldMask.ts`（来源收集只看 r/c/u） |
| 可见集/面包屑/剪枝对每节点复用同一判定内核；库节点改判 `enter`，内容节点判 r | `scope.ts`、`preflightScopeVisibility.ts:50-104`、`nav/prune.ts:45-57` |
| 硬证据：on 态库整层退出可见集（owner visible=78，普通角色 visible=4 且无 base/kb） | be-authz-projection 字节副本实测，提交 8adad3a |

### 1.2 缺陷范围（确认并扩展 team lead 判断）

- **P0-A（库节点判不到数据动作 → on 态 403）**：凡「库可见、但数据动作只在 table 节点」的**所有非超管角色**——含普通只读成员，不止管理员——`requireCanView/EditData/Comment` 在 on 态都会 403。管理员只是最易被注意到的一档（其 visible 来自硬规则、最不依赖 scope 行）。
- **P0-B（库整层退出 S4 可见集）**：on 态库节点因无 r 不进可见集。实测 owner 硬短路 visible=78（base7/kb12/table10/view10/canvas15/doc24），普通角色 visible=4（仅 table2/view2，base/kb 全缺席）。可见集是 M5「先收敛后召回」唯一入口、M3 剪枝消费面，且 `nav/prune.ts:45-57` 的 resourceAncestorsPass 沿 parentId 向上「任一资源祖先不可见即拒」——库被剪则**库连同库内资源一起消失**，不是「能看表点不进库」。
- **P1（requireCanManageBase 语义错位 → OVERALLOW）**：该守现用 `manage_share` 判库管理权。管理员库节点恒持 manage_share（canShare 恒真），致**未勾 canManage 的管理员在 on 态拿到全库管理权**。legacy 中该守答案是 `access.canManage`，两者不等价。

### 1.3 两条死路为什么是死路

**修法 ① 库节点补 `r` —— 撞 A-4，越权。**
fieldMask 的来源收集只认 r/c/u，任一 r 来源 fieldMask 为空即 `visibleAll=true`，`mergeFieldMasks` 对无 mask 来源直接返回不裁剪。库节点补一条不带 mask 的 r，等于向该 table 的字段并集塞一个宽来源，**把逐表字段收窄整体淹没**。反证测试（commit bc698bb）已锁：补 r 后 hidden 字段 f2 重新可见。拿 OVERDENY 换 OVERALLOW，M4 对后者零容忍。

**修法 ② 判定层实时跑「库内活表并集」但沿用 `r` —— 撞 S4 decide↔scope 零分叉，且救不了空库。**
`scope.ts` 可见集按「节点自身位」判定，无祖先提升。守卫若把「库可见」解释为「判定时库内任一表 r」，则守卫说「能进库」、探针说「库不可见」，两者分叉，污染 M5 收敛入口。另有两个边界：空表库（判定时并集空 → deny，而 legacy `canView = access.visible` 是纯库级标志不看表）、全表显式 read:false 而 visible=1。

**根因**：不是「守卫怎么问」的问题，是引擎缺两个能独立表达「库级可见性」「库级可写并集」的一等概念。它们必须同时满足：
(a) 不参与 fieldMask 并集（否则重演①）；
(b) 与 visible-scope 探针同口径（否则重演②）；
(c) 不依赖判定时库内是否有活表（否则救不了空库）。

---

## 2. 定稿方案：两枚库级聚合位 `enter` / `edit_data`

### 2.1 动作词汇新增两枚聚合位

在 `ResourceAction` 封闭枚举中新增 **`enter`** 与 **`edit_data`**。现 `packages/shared-types/src/authz.ts:19-43` 的实际序列为：

```
["r","c","u","d","comment","manage_share","manage_schema","manage_table","enter","edit_data"]
```

长度 8 → 10，两枚新位**追加在末两位**；文件头注释（`:10-18`）已锁定下述口径，作为全项目唯一真源。另导出 `LIBRARY_RESOURCE_TYPES = ["base","kb"]`（`:46`）。

**`enter` 语义（六条硬约束）：**

1. **仅库节点合法**：只在 `resourceType` 为 base/kb 的节点上有意义；挂 table/view/doc/canvas/group 一律非法。
2. **仅判库自身、不向下「授权」**：表达「人能否进入这个库容器」，= legacy `access.visible`，不表示对任何表/记录/字段的内容读。
3. **不产出字段 capability**：来源收集只认 r/c/u，`enter` 既不进 readSources 也不进 writeSources，永不参与 fieldMask 并集、永不制造 visibleAll。满足 (a)。
4. **天然不向下「继承淹权」**：引擎判定恒为「对目标节点链向上收集」（叶→根）。判 table 的 r 时链起于 table，`enter` 位于其下方的库节点，不在收集方向上；判库的 `enter` 时只看库自身及以上（库之上无业务授予）。满足「不淹没逐表/字段收窄」。
5. **与可见集同口径**：visible-scope 对库节点判 `enter`，对 table/doc 等内容节点仍判 r。守卫与探针同一内核、同一动作位，零分叉。满足 (b)。
6. **不依赖活表**：`enter` 由投影直接落在库节点（派生自 visible/canManage），空表库也能表达可见。满足 (c)。

**`edit_data` 语义：**

1. **仅库节点、仅投影派生**：只在 base/kb 节点有意义，且**只由 scope 投影派生、不得手工授予**（不变量 I1，见 shared-types 注释 `:16`）。
2. **恒等于 legacy `perm.canEditData`**：`canManage=1`，或库内任一活表被授 c/u/d（`scopeProjection.ts:122-147`、`guards.ts:63-66`）。
3. **不进字段能力并集**：它不是 r/c/u，结构上进不了 fieldMask（不变量 I2）。
4. **kb 不 emit `edit_data`**：kb 的内容写关在 content 档位（r/c/u/d）上，库门只需 `enter`（`scopeProjection.ts:205-206`）。

> 关键区分：`enter`/`edit_data`（库门聚合位，库节点、无 fieldMask、不向下）与 table 节点的 `r`/`c`/`u`/`d`（内容动作，承载 fieldMask）。同一条 scope 行由 visible=1 导出 `enter` 与表节点只读基线，由 canManage/可写表导出 `edit_data`，保持与 legacy 逐值一致。

### 2.2 投影即聚合：无需请求期内存 OR

初稿的「prepareScope + 内存逐表 OR」已被更简形态取代——**写并集在投影期就由 `anyTableWritable` 算好，连同 `enter` 一起写进库节点策略行**（`scopeProjection.ts:143-147`）：

```ts
function libraryDataActions(input, shape): ResourceAction[] {
  const out = [...enterAction(input)];                       // visible/canManage ⇒ enter
  if (input.canManage === 1 || anyTableWritable(input, shape.tableIds)) out.push("edit_data");
  return out;
}
```

管理员隐含投影同口径（`implicitAdminProject.ts:68-73`）：库节点 `manage_share` + `enter` 恒推；`dto.canManage || anyWritable` 才推 `edit_data`；canManage 再补 manage_table/manage_schema。

由此 on 态七守都是「对库节点判一枚位」的单节点判定，全部复用引擎 `decide`（creator → owner → 命中策略），**零节点集合 OR、零 N 次 decide、零额外 SQL**。这不构成 S4 分叉：投影把「跨表 OR」固化成库节点上一枚与 legacy 同值的位，判定内核与探针完全一致。

### 2.3 确切实现位置

| 关注点 | 文件 | 形态（已落地 / 待接通） |
| --- | --- | --- |
| 枚举与白名单 | `packages/shared-types/src/authz.ts:19-46` | 已含 enter/edit_data，长度 10，`LIBRARY_RESOURCE_TYPES` |
| scope 行投影 | `scopeProjection.ts:118-209` | 已 emit enter/edit_data（base），enter（kb） |
| 管理员隐含投影 | `implicitAdminProject.ts:54-89` | 已 emit enter/edit_data + 管理位 |
| kind-动作合法性 | `policyAdmin.ts:165-168`（actionLegalForNode） | 需登记 enter/edit_data 仅 base/kb、不得手授（见 §4.2） |
| 守卫动作位 | `guards.ts:166-247` | **待接通**：现仍传 r/u/comment/manage_share，须按 §2.4 改判聚合位 |
| 可见集库门 | `scope.ts` + visible-scope 探针 | 库节点判 enter（§3.3） |
| 聚合位等价体检 | `preflightReachability.ts` | enter/edit_data 对拍 legacy，`mismatches` 须为 0 |
| 库整层可见体检 | `preflightScopeVisibility.ts` | `orphanTableUsers` 须为 0 |

> 不新增 `libraryDecide.ts`。判定一律走引擎 `decide`，授权布尔不另写。

### 2.4 七守 on 态落点总表（与第二代 legacy 逐值等价）

| # | 守卫 | legacy 答案 | on 态节点 | on 态动作位 | 与 legacy 等价 | 本次改动 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | requireCanView | `access.visible` | base 节点 | **`enter`**（由 `r` 改） | enter=visible | 改动作位 |
| 2 | requireCanEditData | visible && canEditData | base 节点 | **`edit_data`**（由 `u` 改） | edit_data=canEditData | 改动作位 |
| 3 | requireCanComment | visible && canComment | base 节点 | **`edit_data`**（由 `comment` 改） | canComment=canEditData=edit_data | 改动作位 |
| 4 | requireCanManageSchema | visible && canManageSchema | base 节点 | `manage_schema`（不变） | = canManage | 不变 |
| 5 | requireCanManageBase | visible && canManage | base 节点 | **`manage_table`**（由 `manage_share` 改） | manage_table 仅 canManage 投影，= canManage | **纠正错位** |
| 6 | requireCanToggleShare | visible && canToggleShare | base 节点 | `manage_share`（不变） | canToggleShare=canManage∪管理员 | 不变 |
| 7 | requireCanDeleteBase | visible && canDeleteLibrary | base 节点，**conjunction** | `d`（不变，legacy ∧ 引擎） | 硬规则 A 仅超管 | 不变 |

**requireCanComment 用 edit_data 的依据**：legacy `canComment = canEditData`（`guards.ts:71-73`），而 `edit_data` 恒等于 canEditData，故判 edit_data 即逐值等价，无需独立 comment 聚合位。

**requireCanManageBase 纠正说明**：其 5 个调用点（`bases.ts` rename 主路由及取/建/删分享链接处）语义都是「对该库有完整管理权」，legacy 答案恒为 `access.canManage`。`manage_table` **仅当 canManage=1 才落库节点**（`scopeProjection.ts:149-151`、`implicitAdminProject.ts:73`），管理员不隐式持有——忠实表达 canManage；`manage_share` 在 canManage∪canShare 下都成立（管理员恒真），用作库管理判定会把未勾 canManage 的管理员放进来（P1 OVERALLOW）。`requireCanToggleShare` 才是应判 manage_share 的守。

> rename 在字面上是「库容器属性管理」，用 manage_table 承载略有跨度，但二者授权来源完全同集（canManage），不新增动作位即可闭合，符合「恰到好处」。若后续要独立 library_settings 位，另立 ADR，本次不做。

---

## 3. 空表库、继承中断、kb 边界、性能

### 3.1 空表库（无活表）

- 库可见性由库节点自身 `enter` 表达，不依赖活表。空表库 on 态 requireCanView 判 enter → 200，与 legacy `visible` 一致。
- **无需在库节点放任何「可继承 r」或「最窄 mask r」**。补 r 会越权；补最窄 mask（`{allowFields:[]}`）mergeFieldMasks 视为不宽放、方向反。enter/edit_data 不进字段并集、不向下继承，是正确载体。
- 空库 requireCanEditData/Comment：canManage=0 且无活表 → 投影期 `edit_data` 不 emit → 判 false，与 legacy（无可写表）一致；canManage=1 则投影 edit_data，短真，亦一致。

### 3.2 继承中断（InheritanceToggle）

- table `inheritAncestors=0` 时链在自身停止，不收集库节点策略。但 `enter`/`edit_data` **本就不被 table 在内容判定中使用**（table 内容读用自身 r），故中断不影响库门，也不会意外放权。
- 库门聚合位恒在库节点自身判定；库节点之上无业务资源祖先，库自身继承开关对 enter/edit_data 无实际影响。
- 中断后该 table 可否访问：on 态以 table 自身 r（+fieldMask）为准，与 M4-S7 剪枝一致，父无权子有 direct 时可经 shortcut/直达 URL 到达。

### 3.3 kb 侧与 requireDocAccess 对齐

- kb 容器成员资格（requireKb）on 态判 kb 节点 **`enter`**。projectKb 在 kb 可见时于 kb 节点同时投影 `enter` + content r/c/u/d/comment + 管理位（`scopeProjection.ts:202-209`）；content r 保留，供 doc/canvas 沿 kb→doc 继承做内容判定。
- **requireDocAccess 的对拍 ref 对齐 kb 节点**：现状 `routes/kb/shared.ts` 以 `{ resourceType: doc|canvas, resourceId: docId }` 判 r，而内容授权挂 kb 节点靠继承；一旦 doc 中断继承，doc 自身判 r 会假漂移。改为在 **kb 节点（`nodeId("kb", kbId)`）** 上对拍内容 r/u，与真实落点一致。
- `KB_CONTENT_KEY = "content"`：kb 逐表投影用该伪表 key 的逻辑不变；enter 是库门独立位，不经 content 伪表。
- kb 节点不挂 manage_schema（仅 table/base 合法）；enter 允许 kb、edit_data 不挂 kb，均需在 actionLegalForNode/投影登记。

### 3.4 性能与有界性

- **零 N 次 decide / 零请求期聚合**：写并集在投影期固化为 edit_data，七守都是对库节点的单次 decide，复用 S4 单节点路径。
- 投影成本随既有 scope 投影批次，不新增查询面；可见集仍是 prepareScope 固定成本（非 owner 4 条 SQL，owner 3 条）。
- 规模门（M4 S4：500 用户 / 万节点 / 3000 策略）已证全量预取有界，本次不引入新增长。
- 上线前在规模夹具复验：聚合位投影 + on 态判定的 SQL 定数、P95 不劣于 S4、RSS 有界，并保留 authoring identity（系统自动写不受 enter 约束）。

### 3.5 聚合位新鲜度（staleness）：反驳「投影位会 OVERDENY」与残余闸

**反对意见**：`edit_data` 是投影期算出的快照，库内新增授权活表后、重投影完成前，on 态会 OVERDENY；而运行时聚合（初稿 §0.1）永远新鲜。

**裁决：仍采投影位。** 理由：

1. **运行时聚合同样吃快照**。它判的是各 table 节点的投影策略；若新表策略尚未投影，逐表 OR 一样漏判。它只多救「表策略已新、库位未新」这一格，而这一格正被事务内重投影覆盖：`rebuildScopePoliciesTx` → `expectedRole` 每次都用 `loadLiveShape` 现算（`scopeDoubleWrite.ts:88-99`），挂在 scope 行写入点、回填与 reconcile 修复路径上；建表另有 `projectAdminForNewTableTx`（已接线 `tables.ts`/`records.ts`/`tableServiceTx.ts`）。
2. **初稿运行时聚合有更硬的缺陷**：它要把 legacy 算出的 `access.canManage` 当入参传进引擎判定路径（`libraryWriteAllowed(p, canManage)`）。on 态本应「引擎为权威」，这等于把 legacy 权威掺回引擎结论。投影位方案不需要这个参数。
3. **陈旧可检测、可修**。preflightReachability 的 legacy 期望由活 scope 行 + 活 config 现算（`preflightReachability.ts:73-88`），投影一陈旧即 `mismatches>0`；reconcile S 段可 `--apply` 修复。运行时聚合跑在请求里，既检测不到也修不了。

**残余闸：逐写点实测结论（证据，非推断）**

| 写点 | edit_data 是否重算 | 证据 | 失效窗口 |
| --- | --- | --- | --- |
| 1. 新建表 | **无窗口**（edit_data 不受影响） | `tableActions`（`scopeProjection.ts:76-95`）：普通角色按 `cfg.tables[tableId]` 取 c/u/d，新表在 config 无条目 → 只给 r，故 `anyTableWritable` 不变。`projectAdminForNewTableTx`（`scopeDoubleWrite.ts:189-214`）只补 admin 表节点，与 edit_data 无关 | 无 |
| 2. 改表级授权（scope 行 / config 变更） | **已覆盖，同事务** | `routes/v1/org/roleLibraryScopes.ts:24` → `rebuildScopePoliciesTx` → `expectedRole`（`scopeDoubleWrite.ts:88-99`）每次 `loadLiveShape` 现算 | 无 |
| 3. 删除表 | **未覆盖 → OVERALLOW** | `softDeleteTableTx`（`domain/tableServiceTx.ts:197`）与 `routes/tables.ts:190` 无任何投影/重算调用。删掉唯一可写表后 `cfg.tables` 条目仍在、但 `shape.tableIds` 不再含它 → legacy `canEditData` 转 false，投影 `edit_data` 仍 true | **真实存在** |
| 4. 恢复表 | **未覆盖 → OVERDENY** | `recycle.ts`/`tables.ts` 无 restore 投影钩子 | **真实存在** |
| 5. 库软删/恢复 | 已覆盖 | `expectedRole` 活库过滤（`scopeDoubleWrite.ts:81-92`） | 无 |

**裁决：3 与 4 是翻闸阻断项（不是可接受风险）。** 方向 3 是 OVERALLOW，M4 对越权零容忍，不能靠"下层守卫还会拦"自证安全——guard 层已先给出与 legacy 相反的放行结论，drift 计 OVERALLOW。

**补法（改动小，同事务，不新增语义）**：在 `softDeleteTableTx`（`tableServiceTx.ts:197`）与表恢复路径各加一次 `rebuildScopePoliciesTx`（或等价的按库重投影），与建库/scope 写入同一原语；表复制（`tables.ts:359`）同理可复用。补充测试：删表与恢复表后立即对拍 `edit_data` ↔ legacy `canEditData`。

---

## 4. 必须改动的文件清单

> 本表供实施 worker 据以编码。枚举/投影/管理员已落地；守卫动作位与对拍登记为剩余切片。

### 4.1 shared-types（已落地，复核）

| 文件 | 改动 |
| --- | --- |
| `packages/shared-types/src/authz.ts` | 已增 enter/edit_data（末两位，长度 10）、`LIBRARY_RESOURCE_TYPES`，含 I1/I2 注释 |
| `packages/shared-types/src/__tests__/authz-row-conditions.test.ts` | 长度断言 8→10；新增「末两位为 enter/edit_data、封闭枚举、仅投影派生」用例 |

### 4.2 API - 引擎与合法性

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/domain/authz/policyAdmin.ts` | `actionLegalForNode`（:165-168）：enter 仅 base/kb 合法；edit_data 仅 base/kb 且**禁止手工 upsert**（只接受 reason='scope:role' 的投影行）；其余节点拒绝 |
| `apps/api/src/domain/authz/evaluate.ts` | 不改判定逻辑（fieldPasses 对非 r/c/u 动作返回 true，聚合位不做字段裁剪）；补注释确认 enter/edit_data 走三档命中 |
| `apps/api/src/domain/authz/fieldMask.ts` | 不改逻辑（来源只收 r/c/u）；文件头补「enter/edit_data 不参与 capability」 |
| `apps/api/src/domain/authz/enforceGate.ts` | 无需新增聚合形态：七守改判聚合位后走现有单节点 on 路径；失败/缺节点沿用既有记账 |
| `apps/api/src/domain/authz/adapter.ts` | 无需新增入口；`engineDecideResource` 对 enter/edit_data 透明 |

### 4.3 API - 投影与双写（已落地，复核）

| 文件 | 改动 |
| --- | --- |
| `scopeProjection.ts` | base 库节点 emit enter/edit_data + 管理位（零表库也 emit enter）；kb 节点 emit enter（不 emit edit_data），与 content r 并存 |
| `implicitAdminProject.ts` | 管理员库节点恒 enter+manage_share，canManage∪anyWritable 才 edit_data，canManage 再补 manage_table/manage_schema；kb 节点 enter 但不 emit edit_data |
| `implicitAdminShared.ts` | 拆分后的共享纯函数（与 `implicitAdminProject.ts` 同批产出），纳入清单 |
| `scopeDoubleWrite.ts` | 更新 `projectAdminForNewLibraryTx` 头注释为「库节点预期 enter/edit_data + 管理位」；**`expectedRole` 增加活库过滤**（`base.deletedAt==null` / `knowledgeBase.deletedAt==null`，`:81-92`）——这是 I1 的必然后果：`enter` 无条件由 visible 派生，不过滤会给已删库生成孤儿策略并扩大管理员投影面。判据只取 `deletedAt`，**不叠加 nav 节点存在性**（见 §4.3 注）；另按 §3.5 补删表/恢复表重投影 |
| | **注（裁决 a-②）**：nav 节点缺失不作为投影过滤条件。理由是 fail-close 方向相反——按 nav 存在性过滤会在 nav 缺口期间静默取消用户授权（OVERDENY 且不可见），而 nav 完整性属 M3 职责。改为**只检测不过滤**：在 reconcile/preflight 增加「活库但 nav 节点缺失」的报告型信号，由 reconcile-nav 修复 |
| `scopeProjectionTx.ts` | 确认 replace/upsert 对新增两枚位透明 |

### 4.4 API - 守卫与 kb（剩余核心改动）

| 文件 | 改动 |
| --- | --- |
| `apps/api/src/guards.ts` | requireCanView：r→**enter**；requireCanEditData：u→**edit_data**；requireCanComment：comment→**edit_data**；requireCanManageBase：manage_share→**manage_table**；各守卫 legacyAllowed 仍由第二代算出，文案口径不变 |
| `apps/api/src/routes/kb/shared.ts` | requireKb 判 kb 节点 enter；requireDocAccess 对拍 ref 由 doc 节点改 **kb 节点**（r/u 不变） |
| `apps/api/src/routes/kb/index.ts` | kb.delete 缝动作由 manage_share 改为对齐删库（conjunction+d，见 §5.1） |

### 4.5 体检 / 对账 / 脚本

| 文件 | 改动 |
| --- | --- |
| `preflightReachability.ts` | 已以 `computeLibraryAggregateParity` 对拍 enter/edit_data ↔ legacy visible/canEditData；退出看 **`mismatches=0`、`errors=0`**（旧 libraryUnreachable 已废弃） |
| `preflightScopeVisibility.ts` | 库整层可见抽样；退出看 **`orphanTableUsers=0`**（库节点按 enter，注意该模块当前逐库判 r 的位置须同步改 enter） |
| `preflight.ts` | 汇总上述两段；阻断文案随方案更新为「聚合位不等价 / 库整层退出」 |
| `reconcile.ts` | A3 增加条件：`reason==='scope:role'` 的机器投影**排除出 A3**（合法等于旧档，非手工污染） |
| `scripts/authz/project-scope.ts` | 复用，无需改；存量以新投影重跑 `--apply` |
| `docs/api/openapi.yaml` | 动作枚举补 enter/edit_data；scope 动作说明补两枚聚合位与「仅投影派生」 |

### 4.6 长度/快照断言同步（8→10 的爆炸半径）

| 文件 | 改动 |
| --- | --- |
| `routes/v1/__tests__/policies-api.test.ts` | perAction 长度随 RESOURCE_ACTIONS 常量自动跟随，复核；手授 edit_data 应被拒用例 |
| `routes/v1/__tests__/s9-identity-snapshots.test.ts` | 同上，身份快照含聚合位 |
| `docs/__tests__/s8-openapi-shapes.test.ts` | openapi 枚举快照补 enter/edit_data |
| `domain/authz/__tests__/scopeBackfill.test.ts` | 库节点期望补 enter/edit_data（管理库：`edit_data,enter,manage_schema,manage_share,manage_table`；纯只读库：`enter`）；kb 用例补 enter、不 emit edit_data/manage_schema |
| `domain/authz/__tests__/scopeDoubleWrite.test.ts` | 库节点期望补 enter/edit_data |
| `domain/authz/__tests__/backfill-reconcile.test.ts` | base owner 动作串补 enter/edit_data；kb owner 补 enter |
| `__tests__/r1-guards-enforce.test.ts` 3.5 组 | 按 §6 第 3 条翻转冻结断言 |

---

## 5. kb.delete 动作缝与 4 处零 shadow 缝：是否纳入翻 on 阻断范围

### 5.1 kb.delete shadow 缝用错动作（纳入，P0 对拍正确性）

`routes/kb/index.ts` kb.delete 现以 manage_share 对拍，而 legacy 实为 `canDeleteLibrary`（硬规则，仅超管）。on 态真实授权仍由 `access.canDeleteLibrary` 控制（不直接越权），但非超管可能持 manage_share，致对拍假漂移、掩盖真实差异。

**结论：纳入本次阻断范围。** 该缝不再用 manage_share，沿用 requireCanDeleteBase 同口径——以 **conjunction** 借 `d` 作必要条件对拍（删 kb 必删内容），权威答案仍以 `access.canDeleteLibrary`（仅超管）为准；owner 兜底 allow，非超管 legacy deny。不新增动作位。

### 5.2 4 处零 shadow 提级闸（纳入退出清单，分级处理）

四处：`recycle.ts` 永久删（owner-only）、`index.ts` 分享总闸（canToggleShare）、`docs.ts` 找回（content.update）、`sharing.ts` 分享链接（canShare）。它们当前不经 enforceGate，on 态对其响应零改变，继续按 legacy 判定——故不是「翻 on 即出错」的即时缺陷。

但它们都是破坏性/外发高权限写，翻 on 后引擎对其零验证、零对拍，属「引擎接管盲区」。未验证等价即宣称「权限引擎已接管」不诚实，未来切引擎也无影子数据兜底。

**结论：不作即时 P0 代码缺陷，但作为「引擎接管完整性」纳入退出清单（§6 第 7 条）。** 要求：

- 补 shadow 对拍缝（动作/节点对齐真实 legacy 语义：永久删→库管理位 conjunction、总闸→manage_share、找回→kb content u、分享链接→manage_share/canShare）；
- shadow 观察一个既有周期，4 缝双向 drift 归零方可翻 on；
- on 态这 4 处本期仍以 legacy 为权威，runbook 显式登记「on 仍 legacy、随旧分支退役一并切换」，对外不得声称已被引擎接管。

> 强制本次全切引擎会显著扩大改动面且无 shadow 支撑；完全不纳则留高权限盲区。折中「补对拍、shadow 归零、on 仍 legacy、登记在案」。

---

## 6. AUTHZ_ENFORCE_READY 翻转退出清单

只有以下**全部**满足，且仅由项目总监下令，才把 `configAuthz.ts` 的 `AUTHZ_ENFORCE_READY` 由 false 置 true：

1. **核心修复落地**：enter/edit_data 聚合位 + 七守动作位按 §2-§4 接通，四门（tsc / vitest / eslint / 文件 ≤300 行）通过。
2. **preflight 阻断归零**：
   - 聚合位等价 `preflightReachability.mismatches = 0`、`errors = 0`（enter=visible、edit_data=canEditData 逐值对拍）；
   - 库整层可见 `preflightScopeVisibility.orphanTableUsers = 0`；
   - coverage gap = 0，reconcile A/B/C/S 阻断码全 0。
3. **冻结断言翻转**：`r1-guards-enforce.test.ts` 3.5 组：
   - 根因断言由「base 节点无 r」改为「库节点持 enter/edit_data、不持内容 r」；
   - 管理员由 403 翻 **200**、overDeny 翻 **0**；移除 TODO(P0) 或改已闭合说明。
4. **S4 零分叉保持**：scope-parity 全绿（聚合位进入矩阵后逐节点 scope↔decide 一致）；visibleTotal 与 decide 真值计数恒等。
5. **存量重投影与新鲜度闸**：重跑 `scripts/authz/project-scope.ts --apply`，所有活库（含空库、kb）聚合位与管理位到位；重跑后 preflight 全 0、幂等（第二次 changed=0）；且 §3.5 列出的并集影响写入点（建表/删表/恢复表/config 改表级写权限/库软删恢复）全部事务内重投影，缺则补齐并补对拍测试。
6. **A3 口径修正**：A3 排除 reason='scope:role'；字节副本上清 A1（补投影）/B2（删断节点 legacy），验证不扩大删除面。
7. **接管完整性**：kb.delete 改 conjunction+d；4 处零 shadow 缝补对拍且观察期双向 drift=0；「on 仍 legacy」边界登记 runbook。
8. **on 态穷举测试新增**：见 §7，全部身份×七守（含 kb 侧）强制 on 端到端绿，含字段收窄/继承中断/空库对抗。
9. **规模与性能复验**：规模夹具上投影+on 判定 SQL 定数、P95 不劣于 S4、RSS 有界。
10. **灰度与回滚就绪**：翻 on 经 Feature Flag 分阶段（内部→小比例→全量），runbook 写明 on→shadow/off 即时回退与观察指标。

---

## 7. 测试计划（补 shadow 观察不到 on 缺陷的方法论盲区）

### 7.1 盲区机理（写进测试文件头）

shadow 态响应恒等于 legacy，引擎结论只计数、不参与放行。on 态「以引擎结论为权威」才暴露的差异，在 shadow 不改变任何请求结果；即便 shadow 计 OVERDENY，也依赖人工看指标，管理员/owner 硬短路、库级失效易在聚合视图被掩盖。**shadow 干净 ≠ on 安全**。必须强制 on（mock effectiveAuthzMode='on'，绕过总门物理降级）跑真 app/真 JWT/真守卫，让引擎结论真正决定放行。

### 7.2 必新增测试

1. **on 态穷举：身份 × 七守矩阵**
   - 身份至少含：超级管理员、管理员（无该库 scope 行）、管理员（有 canManage）、库管理员(canManage)、编辑者、只读成员、纯 canShare 成员、零角色者、外部分享只读。
   - 对七守逐一断言状态码，与直接由第二代 legacy 计算的期望值表逐格比对，drift 分类全 0。
   - 重点：无 scope 行管理员 View=200（P0-A）；未勾 canManage 管理员 ManageBase=403（P1）；纯只读 View=200、EditData=403。
2. **库整层可见集 on 测试**：普通可见角色 visible-scope 中 base/kb 按 enter 进入；M5 在该 scope 下能召回库级资源（不再整层消失）。
3. **空库 / 全表 read:false 对抗**：空库 View=200、EditData/Comment 按 canManage 正确；visible=1 全表只读时 View 200、Edit 403。
4. **字段收窄不被淹没（防①回归）**：库节点持 enter/edit_data、table r 带 fieldMask（hidden f2），on 态 f2 仍不可见、visibleAll=false。
5. **继承中断对抗**：table/doc 中断后库 enter 仍判库门；内容读以自身 r 为准、不越权；requireDocAccess 在 kb 节点对拍无假漂移。
6. **高权限缝对拍**：kb.delete 与 4 缝 shadow 对拍与 legacy 一致、drift=0；手授 edit_data 被策略校验拒绝。
7. **故障/缺节点 on 行为**：引擎抛错回落 legacy（不 500）；库 nav 节点缺失 fail-closed 403 + UNRESOLVED_NODE。

---

## 8. 结论

- 选定：**两枚库级聚合位 `enter`（库准入=visible）与 `edit_data`（活表可写并集=canEditData），均由窄策略投影派生、落库节点、经同一引擎内核判定**。
- 否决：库节点补 r（A-4 越权）、判定层沿用 r 实时跑库内并集（S4 分叉且空库失效）、库节点补最窄 mask（方向相反）。
- 纠正：requireCanView 判 enter；EditData/Comment 判 edit_data；requireCanManageBase 由 manage_share 改 manage_table，消除管理员 OVERALLOW；requireDocAccess 对拍对齐 kb 节点；kb.delete 对齐 conjunction+d。
- 翻 on：以 §6 十项退出清单全绿为唯一前提，且仅由项目总监下令。
