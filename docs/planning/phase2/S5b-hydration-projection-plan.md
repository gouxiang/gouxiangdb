# S5b hydration 收口 — 文件级实施切片（S5b-Ⅰ 边剪枝 / S5b-Ⅱ 字段投影器）

- 日期：2026-09-13
- 作者：架构师 高见远
- 状态：**终审通过（Conditional Approved，2026-09-13 项目总监大湾区靓仔终审；技术实质 pass，可在满足下方"派单门"后按 P1→P4 派单，每片独立 flag/commit/对拍/度量）。终审修订：#84 P0 已闭环、COUNT #90/#94 已接收、审计脚本 `.mjs`/`load.ts:52-61` 等事实漂移由总监直接更正（见 §4/§6/§10 标注）。**
- 上游依据：ADR-0008（`docs/adr/0008-...md`，终检 Accepted @ commit `1aaf855`）§4 两层成本切分、§5.4 T0 已闭环、§6.3 两片边界、§7 测量纪律、§8 T0–T6；M1 实施计划 §S5/§S10；三审强制拆片裁决（机制偷换纠偏）
- 适用代码基线：终审复核于 `main` @ `1aaf855`。其中 `apps/api/src/domain/hydrate.ts`、`hydrateBatch.ts` 自 `7c7b3c0` 至 `1aaf855` 经总监 `git diff --stat` 复核**仍零字节改动**，故下文行号对 `7c7b3c0` 与当前树同时成立；§1.3 列 10 处 `hydrateRecords`/单条/默认值公式调用点已经总监 grep 逐一核对存在（csvExport×2、paginate×3、planner×3、recordService×2）。
- 环境：Node v22.22.2、pnpm、better-sqlite3 13.0.3（SQLite 3.53.4）、Vitest。

> 本文全部行号最初在 `ebb34a5` 工作树实读核对，终审已于 `1aaf855` 复核 hydrate 两文件零字节改动、行号仍成立。任何尚未实施项一律以未来时态标注，不以既成语气陈述。COUNT 半连接下推（`compileCount.ts`/`sidecarQuery.ts`，任务 #90/#94）已由总监接收闭环（见 §10），但**不是**本计划的前置或组成。

---

## 0. 结论先行

1. hydration 端到端慢点是**两个位置不同、度量不同、必须分别治理**的成本，任何一片都不得用另一片的收益冒领（ADR-0008 §4）：
   - **C-io/oof**：prefetch 对"无任何计算字段引用"的 links/subtable 字段也整段查 link 行。治它 = **S5b-Ⅰ prefetch 边剪枝**。
   - **C-compute**：点引用为取一个子字段 cell，对被引子记录做整记录 `buildFirstPassMerged`（约 30 字段）+ 全公式 `computeFormulas`。治它 = **S5b-Ⅱ 字段投影器**。
2. 两片**各自独立 flag、独立对拍、独立度量**，分别提交，禁止混在一个 commit。
3. 严格顺序门：**P0 #84（harness 达 T0）✅已闭环（§4）→ 点引用环 characterization 落库 → baseline `node --cpu-prof` 归因 → 据归因数据定 Ⅰ/Ⅱ 谁先**。下一个可派单项是 P1 环 characterization。S5b-Ⅱ 落地、或 cpu-prof 用数据证伪 C-compute 主导性之前，ADR-0008 不得声称应用层手段已穷尽，不得据 hydration 指标谈迁 PG。
4. 不做跨请求 memo；不静默截断 links；`{a.b.c}` 链式点引用现状"只切首点→null"是**已知能力边界**，本计划不扩为真两跳（扩了即对环 golden 构成 drift，会被抓出）。

---

## 1. 现状证据（行号已核对）

### 1.1 C-compute：点引用的整记录重算（CPU）

`apps/api/src/domain/hydrate.ts`：

| 位置 | 事实 |
|---|---|
| `buildFormulaSource` `:333-399` | 公式取值源构造；点引用预解析 `for` 循环在 `:343-375` |
| `:343-347` | 对每个 `{关联.子字段}` ref 切出顶层 linkName 与 subName |
| `:349-353` | 按名找 links/subtable 字段；找不到→null |
| `:361-371` | 遍历该公式宿主记录**自身 links 解析出的每一条 LinkRef**，`:364` 载入对端表字段，`:367` 调 `getMergedCached(l.tableId, l.recordId)` |
| `:369` | 调用方只读 `childMerged[subField.id]` **一个 cell**（`cellToFormulaValue`） |
| `getMergedCached` `:414-435` | `:420` 查 `ctx.mergedCache`；`:422` `ctx.merging` 环守卫返回 null；miss 时 `:423` 单条 `getRecordsByIds`、`:428` `buildFirstPassMerged`、`:429` `computeFormulas`、`:430` 回填 mergedCache |
| `buildFirstPassMerged` `:195-258` | 物理/系统/autoNumber（`:203-235`）、**每个 links/subtable 字段整段对端物化**（`:238-243`，调 `resolveReverseLinks:471`/`resolveForwardLinks:462`）、lookup/rollup/count（`:246-255`） |
| `computeFormulas` `:267-309` | `:273` 取该表**全部**公式字段，Kahn 拓扑全量重算 |
| `ctx.mergedCache` `:65` / 初始化 `:77` | 点引用缓存与回源走 `mergedCache` + `deps.getRecordsByIds`，**完全不经过** hydrateBatch 的 prefetch/expandLevel/loadGroups |

关键：`BatchStore.recordCache`（`hydrateBatch.ts:78`）只存 `RawRecord`，从不填 `mergedCache`；S5 只批了 IO，没批计算。`buildFormulaSource` 遍历的是根记录自身 `resolveForwardLinks` 的结果，不是 prefetch 组——**剪 prefetch 边对本路径的调用次数与单次计算量都零作用**，这正是三审判定"只剪边的新版计划=机制偷换"的原因。

### 1.2 C-io/oof：prefetch 对无引用关系整查 link 行（IO / 内存分配）

`apps/api/src/domain/hydrateBatch.ts`：

| 位置 | 事实 |
|---|---|
| `BUDGET_PER_ROOT/MIN/MAX` `:37-39` | 16、夹 [400,2000] |
| `prefetch` `:145-151` | BFS：`:149` 缓存达预算即停，`:150` `expandLevel` |
| `expandLevel` `:194-252` | 单层扩展 |
| `:202-212` | 对 frontier 记录所属表的**每个** links/subtable 字段无条件构造 group：`:208` `fieldOrientation(f)`、`:209` push、`:212` `await this.links.loadGroups(groups)` |
| `:215-228` | 从已暖 link 缓存收集 peerIds：`:218` 再次 `fieldOrientation`、`:222` `rowsFor`、`:223` 取对端 id |
| `:235-250` | 记录预算闸（`newCount >= budget` 停），只 cap 拉入 recordCache 的记录数，**不 cap 已在 `:212` 查询并遍历的 link 行数** |
| `fieldOrientation` `:55-` | **当前未导出**；S5b-Ⅰ 剪边谓词须与 prefetch 同口径，需 `export` 共享，禁止在新文件复制一份导致口径漂移 |

扇出实测（E1，gate §4，首页最老 100 根含 u^4 幂分布超级 hub）：`children`（mm，被 4 个计算字段引用）三档恒定 288–309 行、有界；`ownerLink`（hm，**无任何计算字段引用**）10k 1,272/max 424 → 100k 6,998/max 2,259 → 500k **23,337/max 7,523**。`7c7b3c0` depth=3+[400,2000] 双界已封顶记录膨胀/OOM，故 Ⅰ 的边际收益是 **link 行查询 IO 与预算分配更聪明**，不是再次消除 OOM。

### 1.3 既有可复用机制（不新造轮子）

- **flag 三态范式**：`domain/queryPlan/flags.ts` 的 `resolveX(env=process.env)`，未知/空值一律回退 `"off"`，可注入 env 便于单测。S5b 两个 flag 照此写。
- **度量中枢**：`ops/benchMetrics.ts` 基于 AsyncLocalStorage，`GX_BENCH=on` 才挂 `x-gx-serve-ms/-physical-sql/-prisma-calls/-rss-bytes`（`:83-87`），默认零副作用直通；`notePrismaCall()`（`:35`）已是 ORM 往返计数口径。新指标只在此文件加 ALS 字段与头，非 bench 不进响应契约。
- **bench 子进程**：`scripts/bench/server.ts:103-119` 组 env、`:123` `spawn(process.execPath, ["dist/index.js"], …)` 用受管 Node（杜绝 PATH node 漂移）。cpu-prof 在此按开关把 `--cpu-prof*` 注入 argv（§7.3），不碰生产 `index.ts` 启动。
- **hydrateRecords 批调用点**（本计划要保证逐值不变的出口，本机 grep 实得 10 处）：`csvExport.ts:85,:103`；`recordService.ts:249,:296`；`queryPlan/planner.ts:126,:136,:157`；`queryPlan/paginate.ts:144,:168,:191`。另有单条入口 `hydrateRecord`（`hydrate.ts:138`，内部转 `hydrateRecords([r])`）与默认值公式入口 `evaluateRecordFormula`（`hydrate.ts:443`，经 `defaults.ts:81`）。
- **字段元数据**：`packages/shared-types/src/api.ts` —— lookup/rollup/count 的 `linkFieldId`（`:128`）、`lookupFieldId`（`:136`）、公式 `formula`（`:143`）、subtable 展示列 `displayedFieldIds/visibleFieldIds`（`:149,:153`）。展示列是 UI 概念，**不进引用闭包**。

---

## 2. S5b-Ⅰ：prefetch 边剪枝（治 C-io/oof）

### 2.1 目标与边界

按"**被引用的 link 字段闭包**"过滤 `expandLevel` 的 groups 与 peerIds：只对被某计算字段（lookup/rollup/count/点引用公式）沿依赖图实际引用到的 links/subtable 字段预取 link 行；未被引用的（如 `ownerLink`）不再在 prefetch 阶段整查。

**红线（保值，任何一条破了即 fail）**：

1. 只剪 **prefetch 组**。展示用 links/subtable 列的对端 LinkRef 永远由 `resolveForwardLinks:462`/`resolveReverseLinks:471`/`buildLinkRefs:482` 在 hydration 第一轮现解析，这三个函数与 `LinkLoader` 一行不改。
2. 剪枝只影响"预热了多少"，**绝不影响取值**：未暖记录/未暖 link 行由既有 cache-miss 路径（`hydrate.ts:423` 单条 `getRecordsByIds`、`hydrateBatchLinks` 加载器 miss 兜底）回源。
3. 不静默截断、不丢 LinkRef、不改 link 行解析语义。

### 2.2 文件级改动（终审后实施）

| 文件 | 改动 | 说明 |
|---|---|---|
| `domain/hydrateBatch.ts` | `export function fieldOrientation(...)`（`:55`） | 仅加 `export`，函数体不动；供闭包计算共享同一方向判定 |
| `domain/hydrateProjection.ts`（**新增**） | `referencedLinkFieldIds(fieldsByTable, rootTableId): ReadonlySet<string>`（命名可议） | 计算"被引用 links 字段 forwardId 闭包"。来源：① type∈lookup/rollup/count 字段的 `linkFieldId`（api.ts:128）；② 公式字段 `formula` 中 `{顶层名.子字段}` 的顶层名解析到的 links/subtable 字段 id；③ 沿 lookup/rollup/count 与点引用**跨表传递**（子表上的计算字段又引用它自己的 link，则 d2/d3 继续），深度受既有 `DEFAULT_PREFETCH_DEPTH=3`（hydrateBatch.ts:29）约束，不另扩深度。纯函数、不查库、可注入字段表，单测全覆盖 |
| `domain/hydrateBatch.ts` `expandLevel` | groups 构造 `:207-210` 加谓词：`if (prune && !referenced.has(o.forwardId)) continue;`；peerIds 循环 `:217-219` 用**同一谓词**过滤 | 两处必须同谓词，否则会"查了 link 行却不拉记录"或反之，造成新的浪费/不一致。闭包在 `prefetch` 入口按根表算一次透传，不在每层重算 |
| flag 解析 | 新增 `resolvePruneEnabled(env)`（就近放 hydrateBatch.ts 或小 flags 文件，范式照 queryPlan/flags.ts） | `GX_HYDRATE_PRUNE`：`off`（默认，含未设置/未知）行为与今天**字节一致**；`on` 启用剪枝。**不设 shadow**（本片不改取值，无 drift 可对，价值只在计数/内存，见 §2.4） |
| `ops/benchMetrics.ts` | ALS `BenchStore` 增 `prunedLinkGroups`/`prunedLinkRows` 计数 + `x-gx-pruned-groups`/`x-gx-pruned-link-rows` 头（仅 GX_BENCH） | 由 LinkLoader 在被剪分支回报"本会 loadGroups 的组/行数"；无法精确得行数时只报组数，行数口径在报告注明估算方式，**不编造** |

### 2.3 测试

- 新增纯函数单测：`referencedLinkFieldIds` 对"无引用 hm（ownerLink）/被 lookup 引用 mm/被点引用公式引用/跨表 d2 传递/subtable 双向"五类字段表给出正确闭包；`fieldOrientation` 导出后行为不变。
- **展示红线专项测试**（关死红线）：prune=on 下，构造一个仅作展示、无任何计算字段引用的 hm 列，断言 Grid 返回行的该列 LinkRef 标题/数量与 prune=off、与 legacy（`GX_HYDRATE_PREFETCH=off`）**逐值相等**（走 cache-miss 兜底保值）。
- 既有全部 hydration 对拍在 `GX_HYDRATE_PRUNE` 未设（默认 off）下必须零变化；prune=on 再跑一遍全 hydration 逐值对拍。
- 预算边界：剪枝后 `[400,2000]` 预算闸语义不变，被引边在预算内优先暖（剪边释放的额度让给被引边）。

### 2.4 度量（允许声称的白名单）

prune=on vs off（同库同场景，串行无并发排队）只允许报告：

1. 被剪边本会 `loadGroups` 的 **link 组数 / link 行数**（`x-gx-pruned-*`，后者须标口径）；
2. prefetch **recordCache 峰值条数**与进程 **RSS 峰值**（`x-gx-rss-bytes` 全程取 max）；
3. prefetch=on 下 home 类场景的**服务端墙钟**（`x-gx-serve-ms`）与 **ORM 往返数**（`x-gx-prisma-calls`）。

**禁止声称（破了即冒领，verdict=fail）**：降低点引用 CPU、缩短 `getMergedCached/buildFirstPassMerged/computeFormulas` 自身耗时、达成 80–250ms 任何 CPU 时延目标、"解释/修复 7k v_range 14.1s"。14.1s/prisma214 是 C-compute 的 E3 观察（且 5k/7k 量级别混用），归 S5b-Ⅱ 用 cpu-prof 复验，与本片无关。本片**不产出** cpu-prof 结论。

---

## 3. S5b-Ⅱ：字段投影器（治 C-compute）

### 3.1 目标与边界

点引用分支不再为取一个子字段而整记录重算：只解析"被引用子字段的**最小依赖闭包**"所需的字段与 link 行，按 (对端表, 子字段) 聚合成批量 IN 波，替代逐条 `getMergedCached` 的整记录 `buildFirstPassMerged + computeFormulas`。

硬约束：

1. **不复制物化算法**。投影器复用 `buildFirstPassMerged`/`resolveLookup`/`applyRollup`/`resolveCount`/公式求值的既有纯逻辑，通过"included 字段集合"收窄计算面，不得另写一套 lookup/rollup/公式实现（两套必漂移）。
2. 列表与默认值公式取值必须继续一致（`hydrate.ts:193` 注释锁定的两链路等价）。
3. 闭包解析失败、字段元数据缺失、环、跨表深度超界等任一异常 → **回退当前全量 `getMergedCached`**，宁全勿错。
4. 循环点引用（A 公式点 B，B 点 A）维持现状返回 null、不死循环（`merging` 守卫语义保留）。

### 3.2 文件级改动（终审后实施）

| 文件 | 改动 |
|---|---|
| `domain/project/planner.ts`（**新增**） | `buildFieldClosure(childFields, subFieldId, depth): FieldClosure`：从被引子字段出发，沿"公式字段依赖（`formulaFieldRefs`，含点引用）/lookup.lookupFieldId/rollup·count 的 linkFieldId"求最小字段+link 闭包，产出需要物化的字段 id 集与需要拉的 link 边集；纯函数，环安全（visited），深度受 `DEFAULT_PREFETCH_DEPTH` 约束。**与 S5b-Ⅰ 的 link 闭包是两个函数**：Ⅰ 算"表级哪些 link 字段要预热"，Ⅱ 算"一条点引用要求子记录算哪些 cell"，不得合并成一个模糊谓词 |
| `domain/project/projector.ts`（**新增**） | `class FieldProjector`：`resolveBatch(requests: DotRefRequest[]): Promise<Map<key, FieldValue>>`。把同一拍内所有点引用按 `(peerTableId, subFieldId/闭包指纹)` 聚合，每对端表一条 records IN + 按需 link IN（复用 hydrateBatchLinks 加载器），只物化闭包内 cell；`projectedCache: Map<闭包指纹, Map<recordId,value>>` 挂请求级 ctx；环守卫复用 `ctx.merging` 同语义。键必须含闭包指纹，避免"同一记录不同子字段闭包"互相污染 |
| `domain/hydrate.ts`（最小改，逐点列） | (a) `buildFirstPassMerged:195` 增可选参 `included?: ReadonlySet<string>`：传入时只物化闭包内字段（物理字段直接取、links/lookup/rollup/count 仅在闭包内才解析），不传=现状全量；(b) `computeFormulas:267` 增"仅算闭包交集内公式字段"的可选收窄（`:273` formulaFields 与 included 取交），不传=全表 Kahn；(c) `buildFormulaSource:333-375` 点引用 `:361-371` 改三态分派（off=现状逐条 getMergedCached；shadow=全量照取**且**并行跑投影器比对、只记 drift；on=投影器批波，失败回退全量）；(d) `hydrateRecords:94-122` 在两阶段之间加"整批点引用投影波"，把本批所有公式的点引用请求一次性喂给 `FieldProjector.resolveBatch`，结果挂 `ctx.dotCache` 供 `:369` 读取 |
| `getMergedCached:414-435` | **保留不删**，作为：① flag=off 主路径；② `evaluateRecordFormula:443` 默认值公式路径；③ on 态闭包解析失败的回退。三者保证非列表入口与回退仍取全量正确值 |
| flag | `resolveProjectMode(env): "off"|"shadow"|"on"`（照 queryPlan/flags.ts，默认 off，未知回退 off），env `GX_HYDRATE_PROJECT` |
| drift 上报 | shadow 态：全量值 vs 投影值逐点比对，差异进结构化日志 +（GX_BENCH 下）响应头 `x-gx-project-drift:<count>` 与 `x-gx-project-drift-sample`（截断的首个差异定位，限长）。**绝不影响响应**，响应永远取全量值 |

### 3.3 三态接线（语义）

- **off（默认）**：`buildFormulaSource` 走今天的 `getMergedCached`，投影器代码路径不执行（不是"执行了再丢弃"）。回滚 = 置 off，零数据迁移。
- **shadow**：响应值=全量路径结果（与 off 逐值相同）；额外开销仅在 bench/灰度环境承受；连续一个迭代 drift=0（含全部环夹具与 214+ 对拍）才允许 on。
- **on**：点引用走投影批波；任一请求级回退发生（闭包解析抛错/缺字段/环超深）则该点退回 `getMergedCached` 全量，并在 bench 头计数 `x-gx-project-fallback`，回退率本身是观测指标，不得静默。

### 3.4 测试与对拍

1. 既有全部 hydration / 公式 / cross-formula / csvExport 测试（214+ 断言基线，实施时以 `vitest run` 实际数为准写进报告）在 off 态零变化。
2. 新增投影器单测：闭包正确性（物理/lookup/rollup/count/链式公式/点引用各一）、批聚合 IN 的去重、projectedCache 指纹隔离、环回退、缺字段回退、回退计数。
3. **环 characterization 基线（§5）在 on 态逐值全等**，shadow 态 drift=0；这是翻 on 的硬门槛。
4. shadow 对拍纳入压测 harness：同请求全量 vs 投影 drift 必须 0，非 0 一律阻断 on。

### 3.5 度量（C-compute 归本片，且只认 cpu-prof）

1. **必须携带 `node --cpu-prof` 产物**（ADR-0008 §7.2）：以火焰图中 `getMergedCached` / `buildFirstPassMerged` / `computeFormulas` 三函数（及投影器新函数）的 **self time 占比与绝对毫秒**为准，on vs off 对比；不接受墙钟差反推 CPU。
2. 点引用路径 **ORM 往返数**：off 随"30 字段 × link 数 / 逐条 getRecordsByIds"增长（基线观察 214/请求，E3，#84 已闭环后待固定规格机正式重测），on 应随"被引字段闭包 + 每对端表一条 IN"下降；以 `x-gx-prisma-calls` + 投影器自计 IN 波数双向核对。
3. 若 cpu-prof 显示 C-compute **不占主导**，以数据为准修正方向（可能主因是 better-sqlite3 同步串行排队或 link IO），不预设"S5b-Ⅱ 必大幅提速"；80–250ms 是待证伪的预期，不是承诺。

---

## 4. 前置门 P0：#84 harness 达 T0（后端片）——✅ 已闭环（2026-09-13）

S5b 任何性能数字成立前，压测工具必须先在目标并发下可信（ADR-0008 §5.3、§8 T0）。三条件全满足：

1. 服务端 `<--` 请求计数 == 客户端"成功发送"计数；
2. status=0 样本归零；
3. 目标并发（C=8 起）下 harness 自身连接失败率 = 0。

**终审状态更新（事实更正，覆盖本段原"待实现"措辞）**：P0 已闭环，证据 ADR-0008 §5.4 与 `docs/baseline/2026-09-13-m1-s10-t0-closure-multinum.md`（`53b3663`）。干净 5k/C8/全量 19 场景/3,601 采样 failures=0，FIFO 四流（home 501、view-search 3,500、write-home 120、POST 350）全 0 尾挂。① 原"`load.ts:82` catch 吞掉 error 对象、须先采 `e.name/e.code`"已由 `errorCode()` 落地（`load.ts:52-61`，沿 `error.cause` 链提取 ECONNRESET 等）；② 可复跑对账器实际入库为 **`apps/api/scripts/bench/audit-server-log.mjs`**（commit `e9916da`，含 84 行测试），非早期草稿所写 `.py`；③ **四审根因更正**：雪崩真因是高命中慢查询经 better-sqlite3 同步调用阻塞事件循环、keep-alive 空闲连接被半关，而非 undici 池容量不足；慢查询由 `e656abb` 等消除后，**未加任何 undici Agent 池/队列/背压即过 T0**，故"Agent 池化/队列/背压选型"不再是 S5b 前置，仅保留为可选韧性项。

## 5. 前置：点引用环 characterization（S5b-Ⅱ 的第一个子任务）

> **状态标注（2026-09-13 终审更新）**：本节六点是**架构师拟的环 characterization 规格**，总监终审认可其作为 **S5b 第二个子任务（P1，#84 之后第一个可派单项）的规格输入**。原三个派单前提——本计划终审通过、ADR-0008 落定、#84 与 COUNT 片归属（#90）落定——**截至本次终审已全部满足**（终审通过；ADR-0008 已 Accepted @ `1aaf855`；#84 闭环见 §4、#90/#94 已接收见 §10）。故 P1 可派单：**只锁现状、写 characterization 测试与 golden，不判 bug、不动取值算法、不写任何 S5b-Ⅰ/Ⅱ 生产代码**。

目的：在动 `getMergedCached` 之前，先把现状（含非对称环、钻石、跨表、链式）的点引用取值与拉取次数**锁成可复现 golden**，S5b-Ⅱ 只能保持 golden 逐值不变或显式走差异流程，不得"顺手修 bug 改取值"。

1. **provenance 语义**：commit hash / node 版本只作 golden 的 provenance 元数据记录，**不纳入 `--check` 等值判定**（否则每次提交 CI 必红、多版本 CI 互打）。参与比对的是"图结构 + flags 下的捕获值与次数序列"。捕获值漂移而 provenance 变化时并排展示归因。node 小版本间同代码捕获值若漂移 = 真 drift，照差异流程上报、不静默（确定性 hydration 不该跨小版本漂移；若漂，查 Map 迭代序/排序稳定性这类不确定性）。
2. **R4 钻石走黑盒、不加测试专用导出**：共享子记录 d 被两条路径汇聚，三断言——去重后的拉取次数正确；两汇聚字段取值相等且正确；prefetch recordCache 中 d 仅物化一次。夹具注释须写明"顶层 `hydrateOne` 不查 mergedCache、真正单次只体现在点引路径 `getMergedCached:420` 命中"，防后人数错对象。
3. **P0≠P1 分桶**：按 (路径, 起始顺序) 分桶；桶间不等的测试仍 pass（锁现状可复现），不等项单列"待裁决差异清单"交总监裁决。characterization 纪律：锁现状、不判 bug、不动取值算法。
4. **位置**：`apps/api/src/domain/__tests__/hydrate-ring-characterization.test.ts`；权威 golden 放同目录 `__snapshots__/hydrate-ring-golden.json`，随 PR 评审入库；`docs/baseline/` 只放摘要。已核 `.gitignore`（仅忽略 `artifacts/`、`_tmp_*`、`.workbuddy-artifacts/`），**无 `__snapshots__`/`*.snap` 规则，快照不会被误伤**；实施时仍须 `git status` 再确认快照确实进暂存。
5. **P2（project off/shadow/on 三态）参数化占位 + `skip`**：注明"待 S5b-Ⅱ"，现在不写任何 project 适配代码。
6. **R7 锁"链式 `{a.b.c}` 只切首点→null"**：标注【已知能力边界】非缺陷；与 `buildFormulaSource:345` 只切第一个点一致。S5b-Ⅱ 若变为真两跳，即对 golden 构成 drift，会被抓出并走差异流程。

覆盖矩阵（规格输入）：R3 非对称环 A→B→A 从"A 根 / B 根 / 无关 B 记录"三起始态；R4 钻石共享；R6 跨表环叠 lookup；外加现有双侧 null 环与链式首点语义。P0=确定性必等桶，P1=依赖起始顺序的现状桶，P2=三态占位。

## 6. 执行顺序与派单门

```
P0  #84 harness 达 T0 —— ✅ 已闭环（2026-09-13，ADR §5.4 / baseline 53b3663）
        │  三条件全过，C≥8 数据已允许进性能门
        ▼
P1  点引用环 characterization 落库（§5；纯锁现状，golden 入库随 PR 评审）——下一个可派单项
        │  golden 稳定、差异清单经总监裁决
        ▼
P2  baseline node --cpu-prof 归因（off 态，固定规格机；三函数 self 占比 + ORM 数）
        │
        ▼
P3  数据裁决 Ⅰ/Ⅱ 谁先（不预设；cpu-prof 证明 C-compute 主导则先 Ⅱ，否则先 Ⅰ 或修正方向）
        │  各自独立 flag / 独立 commit / 独立对拍 / 独立度量
        ▼
P4  shadow drift=0 持续一迭代 → 翻 on；ADR-0008 据机更新应用层手段状态
```

ADR-0008 T1 的 100 万行终验仍在 S5b-Ⅱ（或证伪）+ 固定规格 4C8G+SSD 之后，本计划不提前跑、不伪造。

## 7. 度量纪律与接入命令

### 7.1 收益归属（防冒领对照表）

| 指标 | S5b-Ⅰ 可声称 | S5b-Ⅱ 可声称 |
|---|---|---|
| 被剪 link 组/行数、recordCache 峰值、RSS | 是 | 否（非其机制） |
| prefetch-on home 墙钟、ORM 往返数 | 是（仅描述 IO/分配变化，**不归因 CPU**） | 是（点引用路径 ORM：214→随闭包） |
| `getMergedCached/buildFirstPassMerged/computeFormulas` self time | **否** | 是，且**只认 cpu-prof** |
| 80–250ms / 解释 14.1s / 谈迁 PG | **否** | cpu-prof 证实前一律否 |

### 7.2 对拍命令（实施时在 apps/api 下）

```bash
pnpm vitest run src/domain/__tests__/hydrate.test.ts \
  src/domain/__tests__/hydration.batch.test.ts \
  src/domain/__tests__/cross-formula.test.ts \
  src/domain/__tests__/csvExport.test.ts \
  src/domain/__tests__/record-single-hydrate.test.ts \
  src/domain/__tests__/characterization/   # 含 hydration.batch-parity
# 环 characterization 落库后追加：
pnpm vitest run src/domain/__tests__/hydrate-ring-characterization.test.ts
# 三态矩阵：GX_HYDRATE_PRUNE / GX_HYDRATE_PROJECT 在 off(默认)、shadow、on 分别全绿
```

### 7.3 cpu-prof 接入（不碰生产启动）

在 `scripts/bench/server.ts`：读 env `GX_CPU_PROF=1` 时，把 `:123` spawn 的 argv 改为
`[process.execPath, "--cpu-prof", "--cpu-prof-dir=<bench 输出目录>", "--cpu-prof-name=<场景>.cpuprofile", "dist/index.js"]`，
仍用受管 `process.execPath`；`run-gate.ts` 增加透传开关。产物落 bench 输出目录（gitignored），报告附复跑命令。**不**在 `src/index.ts` 加任何 profiler 代码。

```bash
# 固定规格机、#84 达 T0 后（示意，参数以终审为准）：
GX_CPU_PROF=1 GX_HYDRATE_PROJECT=off \
DATABASE_URL=file:/abs/gate-<n>.db \
pnpm tsx apps/api/scripts/bench/run-gate.ts --rows <n> --shape wide --seed 20260913 \
  --warmup 50 --samples 200 --concurrency 1   # 归因先单并发排除排队，再补 C≥8
```

## 8. flag 生命周期与回滚

| flag | 默认 | 取值 | 回滚 | 移除条件 |
|---|---|---|---|---|
| `GX_HYDRATE_PRUNE` | off | off/on | 置 off，立即回到现状 prefetch | on 稳定一迭代 + 红线专项常驻后，另片清理 |
| `GX_HYDRATE_PROJECT` | off | off/shadow/on | 置 off；on 内单次失败自动回退全量并计数 | shadow→on drift=0 持续一迭代，且 cpu-prof 收益达标后，另片评估收口 |

两 flag 正交可组合，但度量与对拍必须覆盖组合矩阵；默认（两者皆未设）行为与今天完全一致。

## 9. 验收清单（Definition of Done）

- [ ] 独立切片、独立 commit，commit 不夹带 queryPlan/搜索/文档等他人在途改动。
- [ ] 默认 off 全量回归零变化（vitest 实际总数写进报告，不用"214+"这种约数充结论）。
- [ ] Ⅰ：展示红线专项 + 逐值对拍全绿；度量只出现 §2.4 白名单指标，无任何 CPU/80-250ms/14.1s 归因字样。
- [ ] Ⅱ：投影器不复制物化算法；三态正确；shadow drift=0（含环 golden）；回退有计数不静默；附 cpu-prof 三函数 self time 与点引用 ORM 数。
- [ ] 环 golden 入库（确认 `__snapshots__` 进 git），provenance 不入 --check。
- [ ] 全程无 emoji（P0 团队规则）；无"已修复/100% 到达"类预写完成态；待实现项标 E4/未来时。
- [ ] ADR-0008 据实测更新，且不越过"应用层手段已穷尽/谈迁 PG"的禁区。

## 10. 明确不在本计划内（边界）

- **COUNT 半连接下推（compileCount.ts/sidecarQuery.ts，任务 #90/#94）**：**已由项目总监独立复验接收并闭环**（`e656abb` 钉 `INDEXED BY rfi_record_field_ord_key` 修多标量字段高命中 AND 多 JOIN 的 O(n³) 计划形状缺陷；ADR-0008 §3.2 E1、100k/500k 前后对比为 E3 待规格机复核；形态防回归 `countJoinMultiNum.test.ts`）。本计划不把它当前置；两片若都触及 queryPlan/hydrate 边界，派单时由总监显式协调先后。**终审更正：本条原文写"总监尚未接收、未立项 S10-C"，与当前事实不符，已覆盖。**
- **跨请求 memo 缓存**：受 NOW/TODAY 非确定性、字段改名、二跳失效影响，一致性代价独立，如要做单独立项，绝不搭车 S5b（ADR-0008 §7.1）。
- **links 有界化 / mega-hub 根扇出截断**：属 S5c 契约问题，须前端联动、不得静默截断（ADR-0008 §7.3 T1 分口径），不在 S5b。
- **链式 `{a.b.c}` 真两跳**：现状只切首点→null（R7 边界），不扩；扩了按 golden drift 流程走。
- **100 万行终验、固定规格机签核**：#84 已闭环；仍待 S5b-Ⅱ（或 cpu-prof 证伪）与 4C8G+SSD 固定规格机。
