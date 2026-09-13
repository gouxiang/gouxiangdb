# ADR-0008：SQLite 容量证伪门与 PostgreSQL 切换阈值（S10 裁决）

**状态**：Proposed（2026-09-13；待项目总监对提交后全文做一致性终检后转 Accepted）
**作者**：架构师 高见远
**评审**：项目总监 大湾区靓仔（三审：机制 pass、证据口径经两轮打回后 §7.2 pass，本稿按其裁决落盘）
**上游依据**：`docs/planning/phase2/M1-implementation-plan.md` §S10（493–516 行）、§8（561–579 行）；`docs/planning/phase1/ARCH-production.md` §3.4；S10 留证 `docs/baseline/2026-09-13-m1-s10-gate.md`（commit `413f4a2`）
**关联 ADR**：ADR-0002（SQLite 选型）、ADR-0003（裸机拓扑）

---

## 1. 背景（Context）

ADR-0008 槽位自架构选型起即预留，专用于"何时放弃 SQLite、立项迁 PostgreSQL"的客观裁决，触发条件在 ARCH-production §3.4 与 M1 实施计划 §S10 中预先写死，禁止凭感觉迁库。

M1/S10 在 1 万 / 10 万 / 50 万本机档执行了证伪压测门，物理索引下推层与应用 hydration 层得出了方向相反的证据；其后一次 5000 行 / C=8 harness 运行又暴露了压测工具自身的客户端连接层缺陷。本 ADR 记录：

1. 两层成本的机制切分与代码锚点；
2. 本轮"不触发迁 PG、S10 性能侧 INCONCLUSIVE"的裁决与理由；
3. 未完成的应用层手段（S5b-Ⅰ / S5b-Ⅱ，独立实施计划另评）；
4. PostgreSQL 切换的客观阈值 T0–T6，其中 T0（压测工具可信度）为本轮新增硬前置。

## 2. 证据分级规则

本 ADR 每个数字必须可追溯到产物与复跑命令。证据分四级，正文随数字标注：

| 级别 | 含义 | 可用于裁决 |
|---|---|---|
| E1 已提交产物 | 在 git 提交中的报告/代码，任何人可重放 | 是 |
| E2 本地产物 | 落于 `artifacts/`（gitignored），附复跑命令可重新生成 | 是（重跑前标注本机） |
| E3 手动观察 | 无报告文件的交互观察，数字仅供方向参考 | 否，必须标"待重测" |
| E4 待实现 | 修复/功能尚不存在（如任务 #84） | 禁止以既成语气陈述 |

反例（本 ADR 不得出现）：把 E4 待实现项以完成时态陈述、把 E3 写进结论表、跨量级（5k 与 7k）混用一个 P95。

## 3. 物理索引层：健康（E1）

依据 `docs/baseline/2026-09-13-m1-s10-gate.md` §2（50 万 main / 70 万 records，best-of-5，热缓存，页 100，生产同款物理 SQL）：

| 物理场景 | best 耗时 | EXPLAIN |
|---|---|---|
| home keyset 首页 | 0.386 ms | COVERING INDEX `records_table_live_created_id` |
| 单选等值 status | 1.133 ms | records COVERING INDEX + sidecar EXISTS INDEX |
| 金额范围 1000..8000 | 1.231 ms | sidecar 数值索引 SEARCH |
| COUNT 过滤后 | 12.153 ms | 索引 SEARCH |
| 无过滤 valueNum DESC 排序（T2 全量物化，固有 SCAN） | 26.011 ms | `SCAN r`（非索引命中场景） |

带过滤的命中场景全部满足"出现 `SEARCH ... USING INDEX`、不出现 `SCAN record_field_index`/`SCAN records`"判据。10 万档同型查询约 1 ms，1 万档 1.0–1.7 ms。

**结论**：50 万行内，SQLite 物理索引路径亚毫秒~12 ms，ADR-0008"物理索引被证伪"的前提不成立。S9/S10 三档端到端写后离线对拍 sidecar drift=0（E1，`ad684d2`，S10 改动仅在读路径预取/readyz 探针/生成器，不触碰写维护逻辑）。

## 4. 应用 hydration 层：两个相互独立的成本

端到端列表延迟（串行，宽表 100 根首页）随整表超线性增长（E1，gate §3.1）：10k post-fix 295–372 ms、100k 2,325–3,583 ms；500k 在 35–39 s 后服务端连接关闭（jetsam/OOM 形态，未抓到显式退出标记）；10k C=8 已完成场景 serve P95 1,594–2,603 ms、单请求 prisma 均值 270–284（E1，gate §3.2）。

机制读码确认：这是两个**位置不同、度量不同、必须分别治理**的成本，任何一片都不得用另一片的收益冒领。

### 4.1 C-compute：点引用触发的全记录重算（CPU 成本）

代码路径（行号以 commit `7c7b3c0` 为准）：

- `apps/api/src/domain/hydrate.ts:343-375` `buildFormulaSource` 点引用分支对公式中每个 `{关联.子字段}`，遍历该公式宿主记录自身 links 解析出的每一条 LinkRef；
- `hydrate.ts:367` 对每条被引子记录调 `getMergedCached`；
- `hydrate.ts:414-435` `getMergedCached` 缓存 miss 时执行 `buildFirstPassMerged`（`hydrate.ts:195-258`，整记录约 30 字段：物理/系统/autoNumber/**每个 links/subtable 字段整段对端物化**/lookup/rollup/count）加 `computeFormulas`（`hydrate.ts:267-309`，该表全部公式 Kahn 拓扑重算），而调用方在 `hydrate.ts:369` 只读 `childMerged[subField.id]` **一个 cell**；
- 该路径的缓存与回源走 `ctx.mergedCache`（`hydrate.ts:65`）与 `ctx.deps.getRecordsByIds`（`hydrate.ts:423`），**完全不经过** `hydrateBatch.ts` 的 prefetch/expandLevel/loadGroups。S5 的 `BatchStore.recordCache` 只存 `RawRecord`、从不填 `mergedCache`（`hydrateBatch.ts:78`），即 S5 只批了 IO、没有批计算。

手动观察（E3，**待重测**，本机 M5/16G，无报告文件）：7000 行库 v_range（纯物理 range、filteredTotal=2968、仅返 100 行、physical-sql=4）prefetch=on 单请求约 14.1 s / prisma 214，C=8 约 85 s。该数字只能用于"点引用路径存在超量计算"的方向判断，**不得**作为阈值裁决输入；归因的 CPU 占比必须由 `node --cpu-prof` 产物给出（见 §7）。

### 4.2 C-io/oof：prefetch 对无引用关系的 link 行整查（IO / 内存分配成本）

- `apps/api/src/domain/hydrateBatch.ts:204-213`：`expandLevel` 对 frontier 记录所属表的**每个** links/subtable 字段无条件构造 group，`hydrateBatch.ts:212` 调 `loadGroups`；
- 该调用发生在记录预算闸（`hydrateBatch.ts:235-250`，夹 [400,2000]）**之前**，预算只 cap 拉入 recordCache 的记录数，不 cap 已查询和遍历的 link 行数；
- 扇出实测（E1，gate §4，首页 createdAt 最老 100 根，含 u^4 幂分布超级 hub）：
  - `children`（mm，被 childTitle/childSum/childCount/firstChild 四个计算字段引用）：生成器限定 0..6 条/根，三档恒定 288–309 行、max 6/根，本就有界；
  - `ownerLink`（hm，**无任何计算字段引用**）：10k 1,272 行/max 424 → 100k 6,998/max 2,259 → 500k **23,337 行/max 7,523**。

`7c7b3c0` 的 depth=3 + [400,2000] 双界已把"记录缓存膨胀 / OOM"封顶，因此剪此边的边际收益是 **link 行查询 IO 与预算分配更聪明**，不是再次消除 OOM。

### 4.3 切库为什么不解决问题

两层成本都是应用层取数/物化形状问题：PostgreSQL 不减少应用发出的查询数，不会让"把 hub 全部关联行读进 JS 算 sum/count"变快，也不会让"为取一个 cell 而整记录重算"消失。计划 §S10 明确"计算字段/全文慢不算触发项"。

## 5. 5000 行 / C=8 harness 运行：客户端连接层失败（E2，工具缺陷，修复待实现）

产物（2026-09-13 14:13 本地，flags read/keyset/prefetch 全 on，warmup 50 / samples 200 / C=8 / limit 100）：

- `artifacts/bench/5000-c8-on.json`、`5000-c8-on.md`
- 服务端读日志 `5000-c8-on.read.server.log`、写日志 `5000-c8-on.write.server.log`

复跑命令（修复后须原样重跑）：

```bash
DATABASE_URL=file:/abs/gate-5000.db \
pnpm tsx apps/api/scripts/bench/run-gate.ts \
  --rows 5000 --shape wide --seed 20260913 \
  --warmup 50 --samples 200 --concurrency 8 --read-p95-ms 0
```

### 5.1 客户端口径（对 JSON 逐场景重算，单一口径）

全量 17 场景合计 **3,201 次采样：625 成功 / 2,576 失败**（`deep_window_edge` 实际 samples=1，非 200）。分 kind：

| kind | 采样 | 成功 | 失败 | 说明 |
|---|---|---|---|---|
| home | 401 | 401 | 0 | home_first 200、home_deep 200、deep_window_edge 1 |
| view | 2,000 | 24 | 1,976 | 仅 filter_eq_select 成功 24，其余 9 场景全败 |
| search | 400 | 0 | 400 | search_short / search_word3 全败 |
| mixed | 200 | 0 | 200 | mixed_home_write 全败 |
| write | 200 | 200 | 0 | write_create 全 201 |

**钉死的单一事实口径**：非 home/write 共 **13 个场景（view 10 + search 2 + mixed 1）2,600 次采样，仅 filter_eq_select 24 次成功，其余 2,576 次为客户端连接层失败**——client P50 0.6–1 ms、serve=0、physicalSql/prismaCalls=0，请求未离客户端（status=0、瞬时 QPS 7k–12k）。服务端带 viewId 进入的请求仅 **82**（含这些场景的 warmup）。

唯一 HTTP 400 出自 `deep_window_edge`，是 S7 keyset"offset 超出窗口"契约的预期状态码，非失败。

可核的服务端性能数字仅 home 两场景（量级=5k，不得与 7k/10k 混用）：home_first serve P95 **1,587 ms** / P99 1,724 ms（client P95 1,665 ms）。

### 5.2 服务端口径（日志 `<--`/`-->` FIFO 配对审计）

审计方法见附录 B（脚本拟随任务 #84 入库 `scripts/bench/audit-server-log.py`，当前为待入库状态）。

- 读库 home（无 viewId）：540 进 / 540 出 / 0 尾挂（539 个 200 + 1 个 400）；
- 读库 view/search（带 viewId）：82 进 / 74 出 / **8 尾挂**，尾挂全部属于最后 C=8 同 viewId（`view_scn...5cwg0`）一批，落在日志 1232–1241 行——客户端放弃等待，非服务端挂死；
- 写库：250 个 POST 全 201；另有 5 个 GET 写后校验，末行在 teardown 时被截断。

### 5.3 定性与处置

该轮证据证明的是 **harness 在 C≥8 下把自身 undici 连接层压爆**，不是 SQLite 或 hydration 的服务端时延；因此 5k C=8 不产出任何性能裁决。任务 #84（后端，状态待实现）拟为 load 侧引入显式 undici Agent 连接池/队列或背压；`apps/api/scripts/bench/load.ts:82` 的 catch 当前只置 timedOut、吞掉 error 对象，#84 须先采集 `e.name`/`e.code` 完成 undici 归因，再谈修复选型。

**T0 解锁三条件（全部满足后 C≥8 数据才可进入性能门）**：

1. 服务端 `<--` 请求计数 == 客户端"成功发送"计数；
2. status=0 样本归零；
3. 目标并发下 harness 自身连接失败率 = 0。

## 6. 裁决

1. **本轮不触发 ADR-0008，不立项迁 PostgreSQL。** 物理索引层在 50 万行亚毫秒命中（§3）；端到端慢点定位于应用层两类独立成本（§4），切库不改变取数形状。
2. **S10 性能侧维持 INCONCLUSIVE。** 理由：① C≥8 下 harness 自身不可信（§5），修复待 #84；② 治理 C-compute 的 S5b-Ⅱ 字段投影器尚未上线，应用层手段未穷尽；③ 100 万行终验待固定规格机（4C8G+SSD）。物理层结论不受 INCONCLUSIVE 影响，为 pass。
3. 应用层未完手段拆为两个独立切片，各自独立 flag / 对拍 / 度量，**不得互相冒领收益**（文件级实施计划另文送审，本节只锁定边界）：
   - **S5b-Ⅰ prefetch 边剪枝**：按"被引用 link 字段闭包"过滤 `expandLevel` 的 groups（治 C-io/oof）。度量只允许声称：被剪边本会 `loadGroups` 的 link 行数、prefetch recordCache 峰值/RSS、prefetch-on 下 home 墙钟与 prisma 调用数。**不得**声称降低点引用 CPU 或达成任何 CPU 时延目标。红线：展示用 links/subtable 列的对端 LinkRef 永远解析（`resolveForwardLinks`/`resolveReverseLinks` 不剪）。
   - **S5b-Ⅱ 字段投影器**：点引用分支只解析被引用子字段的最小依赖闭包，替代整记录 `buildFirstPassMerged + computeFormulas`（治 C-compute）。度量：cpu-prof 中 `getMergedCached`/`buildFirstPassMerged`/`computeFormulas` 自身耗时下降、点引用路径 prisma 调用数随"被引字段闭包"而非"30 字段 × link 数"变化；214+ hydration 逐值对拍、环基线 on 态逐值全等、shadow drift=0。§4.1 的 CPU 时延改善预期归属本片，且数值必须由 cpu-prof 证实/证伪。
   - 顺序：P0 #84（harness）→ 点引用环语义 characterization（非对称环 A→B→A 不同起始根逐值基线，现测试仅覆盖双侧 null）→ Ⅰ/Ⅱ 实现；先做哪片以 characterization 后的 cpu-prof 归因数据为准。**在 S5b-Ⅱ 落地、或 cpu-prof 用数据证伪 C-compute 主导性之前，本 ADR 不得声称应用层手段已穷尽，也不得据 hydration 指标谈迁 PG。**

## 7. 测量纪律（三约束）

1. **不做跨请求 memo。** hydration 缓存生命周期以一次请求为界。跨请求 memo 受 NOW/TODAY 非确定性、字段改名、二跳关系失效影响，一致性代价独立且巨大，如未来要做单独立项，不得搭车 S5b。
2. **gate 报告必须携带 `node --cpu-prof` 产物。** C-compute 占比、80–250 ms 量级的改善预期，一律以 cpu-prof 火焰图中相关函数自身耗时为准，不接受墙钟差推断；若 cpu-prof 显示 C-compute 不占主导，以数据为准修正方向，不预设结论。
3. **T1 口径分离。** mega-hub 根 LinkRef 超大扇出（属 S5c 契约问题：links 有界化须前端联动，不得静默截断）与普通物理页分开报告、分开定阈，防止极端连通度页绑架迁库结论。

## 8. PostgreSQL 切换阈值（T0–T6）

T0 为本轮新增硬前置；T1–T5 沿用 ARCH-production §3.4 与 M1 §S10，触发任一则正式立项 ADR-0008 迁移（本 ADR 转 Superseded 并产出迁移 ADR）。

| 编号 | 条件 | 测量方式 |
|---|---|---|
| T0 | 压测工具在目标并发下自身可信：服务端收包数==客户端成功发送数、status=0=0、连接失败率=0（§5.3） | audit 脚本逐请求对账 |
| T1 | A1/A2/A4/A5/A6 全上线 + sidecar drift=0 + EXPLAIN 命中索引无 SCAN + 计算字段置灰 + **S5b-Ⅰ/Ⅱ 落地** + cpu-prof 归因完成后，固定规格 4C8G+SSD 上物理索引命中场景 100 万行 P95 仍 ≥1.5 s（best-of-5 中 ≥3 轮），或默认首页 ≥800 ms（真实工作负载，连续观察）；hub 扇出页与普通物理页分口径 | run-gate + cpu-prof + 慢查询日志 |
| T2 | 单表活跃行 > 1,000 万 | 每日容量台账 |
| T3 | 单库 > 100 GB | 每日容量台账 |
| T4 | 峰值写 QPS 持续 > 100，或 A6 串行化后仍出现写排队超时 | 结构化写计时器/队列直方图 |
| T5 | 需要多实例水平扩展、高可用或产品形态转为多租户 SaaS | 架构评审 |

T1 失败也必须先出"调索引 / 调 bound / 升 better-sqlite3 / 完成 S5b 剩余片"的二次尝试清单，再谈迁库。

## 9. 影响（Consequences）

正面：

- 迁库决策保持客观门驱动，零外部依赖（私有部署核心竞争力）不因恐慌被牺牲；
- 两类成本被显式分离，后续每片的收益声明有度量边界，防止"修了 IO 却声称修了根因 CPU"；
- T0 把压测工具可信度写进门槛，杜绝脏数据进容量结论。

负面/代价：

- S10 性能侧 INCONCLUSIVE 意味着 100 万终验与容量签核延后，依赖 #84、环 characterization、S5b-Ⅱ 与固定规格机；
- S5b-Ⅱ 触碰 `hydrate.ts` 点引用核心路径，须在 214+ 既有 hydration 对拍之外补非对称环基线，评审通过前不得实施；
- 500k 端到端 OOM 形态未抓到显式退出标记，固定规格机复跑时须同步采集系统 OOM/jetsam 证据闭环。

## 附录 A：证据清单与复跑命令

| 证据 | 级别 | 位置 / 复跑 |
|---|---|---|
| S10 门报告（物理层/扇出/三 fixup/质量门） | E1 | `docs/baseline/2026-09-13-m1-s10-gate.md`（`413f4a2`） |
| BFS 双界 / readyz WAL / 生成器跨批修复 | E1 | commits `7c7b3c0`、`3b6b367`、`22b1fa2` |
| 5k C=8 harness 客户端结果 | E2 | `artifacts/bench/5000-c8-on.json`（gitignored，§5 复跑命令） |
| 5k C=8 服务端读写日志 | E2 | `artifacts/bench/5000-c8-on.{read,write}.server.log` |
| 7k v_range 14.1 s/prisma 214、C8 85 s | E3 | 手动观察，待 #84 后在固定规格机重测，禁止用于裁决 |
| 100 万行终验 | — | 不硬跑、不伪造；待 4C8G+SSD 与 S5b-Ⅱ 后执行 |
| harness C≥8 连接层修复 | E4 | 任务 #84，待实现（拟 undici Agent 池化/队列/背压） |
| 日志审计脚本 | E4 | 拟随 #84 入库 `apps/api/scripts/bench/audit-server-log.py` |
| S5b-Ⅰ/Ⅱ 实施计划 | E4 | 另文送项目总监终审，评审通过前不实施 |

数据生成复跑：

```bash
DATABASE_URL=file:/abs/bench-<n>.db pnpm tsx apps/api/scripts/bench/gen-data.ts \
  --rows <n> --shape wide --seed 20260913 --manifest /abs/bench-<n>.manifest.json
```

## 附录 B：服务端日志审计方法

对 `*.server.log` 按连接内顺序做 `<--`（进入）/`-->`（响应）FIFO 配对：先按登录态与 path 分 home（无 viewId）/ view-search（带 viewId）/ write（POST）三流，各自统计进入数、响应数、按状态码分桶、以及流末无配对的尾挂行号；尾挂须回查同批 viewId 与客户端 samples 时间窗，区分"服务端挂死"与"客户端放弃"。5000-c8-on 的审计结果（home 540/540/0、view 82/74/8、write 250 POST 全 201 + 5 GET 校验）已由项目总监独立手工 FIFO 复核与脚本复算双重对齐。脚本化版本拟随 #84 入库，作为 T0 的对账工具。
