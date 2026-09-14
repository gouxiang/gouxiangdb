# ADR-0008：SQLite 容量证伪门与 PostgreSQL 切换阈值（S10 裁决）

**状态**：Accepted（2026-09-13 项目总监终检 `b119697`：§3 选择性三形态分层经总监独立实测数字逐项复核采纳；同次终检发现 §5/§6/附录 仍把已闭环的 #84 当 E4「待实现 undici Agent」、审计脚本路径陈旧（`.py`，实际入库 `.mjs`）、闭环轮 19 场景证据未回填，由总监本人在终检提交中更正这些事实后置 Accepted。**本 Accepted 仅覆盖物理索引层与 T0 连接层结论；端到端 T3 亚秒与 100 万行终验仍 INCONCLUSIVE（见 §6.2），不被本状态覆盖。** 作者不得自行置为 Accepted。）
**作者**：架构师 高见远
**评审**：项目总监 大湾区靓仔（三审：机制根因切分、PG 切换阈值、证据分级规则 pass；第 5 节失败轮数字经其对 `5000-c8-on.json` 独立重算 3201/625/2576、对 `*.read.server.log` 独立 FIFO 配对得 540/540/0 与 82/74/8 而采纳，非采信作者口径。四审（2026-09-13）：#84 闭环轮 `t0-rerun-on-c8-full` 19 场景/3,601 采样与读/写两日志 FIFO 账目（home 501/501、view-search 3,500/3,500、write home 120/120、POST 350/350，全 0 尾挂）由总监独立跑 `audit-server-log.mjs` 对账采纳，并据此把连接雪崩根因从"undici 池不足"更正为"高命中慢查询同步阻塞事件循环"，§5 随之回填。）
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

## 3. 物理索引层：按选择性分层的三种形态（窄命中健康 E1；多字段高命中计划缺陷已修复 E1+E3；宽命中 COUNT 线性为遗留边界 E3）

### 3.0 判据修正：EXPLAIN 无 SCAN、physical-sql 条数少，不等于物理层快

> 本判据修正来自**项目总监独立实测/独立复验**（2026-09-13，better-sqlite3 只读、best-of 预热），是对其本人此前在证伪门评审中"physical-sql 恒 4 + 无 SCAN → 物理层健康"判断的自我修正；非架构师独立发现。

相关子查询即使每一次都 `SEARCH ... USING INDEX` 命中索引，在**高命中嵌套循环**下仍可达到秒级乃至小时级。因此物理层判据不得只看 EXPLAIN 形态或 SQL 语句条数，必须同时包含**端到端实测时延并按选择性分档**：

1. EXPLAIN 形态：命中谓词须 `SEARCH ... USING INDEX`，窄命中不出现 `SCAN record_field_index`/`SCAN records`；多 JOIN 必须由 `records` 覆盖索引线性驱动、每个 rfi 内表按唯一索引单行 seek，不得由连接键不在其前缀的范围索引当 JOIN 驱动（见 §3.2）；
2. 端到端实测：在窄/宽命中与单/多字段组合下分别取 best-of 实测时延，而非仅断言"用了索引"；
3. 区分 COUNT 与首页取页：filteredTotal COUNT 可能随行数线性（§3.3），首页 keyset 取页则可由覆盖索引 + `LIMIT 101` 短路而恒定。

本节据此把物理层从"健康/不健康"二分细化为三种形态：(a) 窄命中 range/等值 seek 健康；(b) 多标量字段高命中 AND 的多 JOIN 计划形状缺陷（已修复）；(c) 宽命中 COUNT 线性的遗留边界。三者都不涉及应用 hydration 成本，后者仍归 §4。

### 3.1 (a) 窄命中 range seek / 等值：亚毫秒~毫秒，健康（E1）

依据 `docs/baseline/2026-09-13-m1-s10-gate.md` §2（50 万 main / 70 万 records，best-of-5，热缓存，页 100，生产同款物理 SQL）；下表 COUNT 12.153 ms 为该门所用窄过滤档位，与 §3.3 的宽命中 COUNT（11–12 s 级）并非同档，勿混用：

| 物理场景 | best 耗时 | EXPLAIN |
|---|---|---|
| home keyset 首页 | 0.386 ms | COVERING INDEX `records_table_live_created_id` |
| 单选等值 status | 1.133 ms | records COVERING INDEX + sidecar EXISTS INDEX |
| 金额范围 1000..8000 | 1.231 ms | sidecar 数值索引 SEARCH |
| COUNT 过滤后（窄档） | 12.153 ms | 索引 SEARCH |
| 无过滤 valueNum DESC 排序（T2 全量物化，固有 SCAN） | 26.011 ms | `SCAN r`（非索引命中场景） |

窄命中场景全部满足"出现 `SEARCH ... USING INDEX`、不出现 `SCAN record_field_index`/`SCAN records`"。10 万档同型查询约 1 ms，1 万档 1.0–1.7 ms。

**结论（仅针对窄命中）**：50 万行内，SQLite 物理索引在窄命中/等值路径亚毫秒~12 ms，ADR-0008"窄命中物理索引被证伪"的前提不成立。S9/S10 三档端到端写后离线对拍 sidecar drift=0（E1，`ad684d2`，S10 改动仅在读路径预取/readyz 探针/生成器，不触碰写维护逻辑）。

### 3.2 (b) 多标量字段高命中 AND 多 JOIN：计划形状缺陷，已修复（修复 E1 / 前后对比时延 E3）

filteredTotal COUNT 与 keyset 取页编译为 rfi `INNER JOIN`（任务 #90，`38d4d57`/`89e381d`）后，多个标量字段的宽范围谓词**同时高命中**（实测约 60%–80%）时暴露物理计划形状缺陷：修复前优化器可能选 rfi 范围索引 `rfi_table_field_num(tableId,fieldId,valueNum)` 当 JOIN 外层驱动，而连接键 `recordId` 不在其前缀；多个高命中 rfi 集合随之嵌套探测 `records`。每个相关 EXISTS 自身都命中索引 SEARCH，但嵌套循环成本随行数近三次方级膨胀——正是 §3.0 判据修正所指的形态。

项目总监在真库上的独立实测（better-sqlite3 只读、预热后 best-of，Apple M5/16G 本机、非规格机，**E3，待 4C8G+SSD 规格机 best-of-5 复核**）修复前：

| 形态 | 规模/命中 | 时延 |
|---|---|---|
| 单字段数值范围（9493 行） | 合并后相关 EXISTS | 17.4 s |
| 同上 | 旧 S6 双 EXISTS | 52 s |
| 同上 | compileCount 单 JOIN | 0.4 s |
| 单字段窄命中 | 100k / 9% | count 0.026 s |
| 单字段宽命中 | 100k / 63% | count 0.64 s / 首页 0.18 s |
| 单字段宽命中 | 100k / 81% | count 2.5 s / 首页 3.1 s |
| 双字段宽 AND | 100k | 22.8 s（count 与取页皆 22.8 s） |
| 三字段宽 AND | 100k | 数小时级（O(n³)） |

**修复**（commit `e656abb`，任务 #94，E1）：在每个 rfi JOIN 内表加 `INDEXED BY "rfi_record_field_ord_key"`，钉死按 `(recordId,fieldId,ord)` 唯一索引对 `records` 行单行等值 seek，规划器随之稳定以 `records` 覆盖索引 `records_table_live_created_id` 线性驱动外层；COUNT 随行数线性、与 JOIN 数无关。取值口径不变，仍只对标量正向谓词生成，NOT/多选/跨字段 OR/残余回退不受影响。

修复后同批独立实测（**E3，待规格机 best-of-5 复核**）：

| 规模 | 形态/命中 | COUNT | 首页取页 |
|---|---|---|---|
| 100k | 单字段 63% | 0.62 s | 0 ms |
| 100k | 单字段窄 9% | 0.80 s | 0 ms |
| 100k | 单字段宽 81% | 0.42 s | 0 ms |
| 100k | 双字段宽 AND | 0.14 s | 22 ms |
| 100k | 三字段宽 AND | 1.05 s | 52 ms |
| 500k（475001 活行） | 单字段 63%（约 29.7 万） | 11.2 s | 5 ms |
| 500k（475001 活行） | 双字段 57%（约 27.2 万） | 12.6 s | 5 ms |

**定性**：这是**物理计划形状（驱动表选择）问题，不是引擎容量问题**，已随 #94/#90 闭环，真库测试 `countJoinMultiNum.test.ts` 以 EXPLAIN 断言钉死计划形状（多 JOIN 由 records 覆盖索引驱动、JOIN 计划不得出现 `USING INDEX rfi_table_field_num` 当驱动），防回归。**不构成迁 PostgreSQL 依据。** 上述前后对比时延仅 E3，结论以规格机 best-of-5 E1 复核为准。

### 3.3 (c) 遗留边界：宽命中 filteredTotal COUNT 随行数线性（E3，非缺陷、非迁库依据，登记后续优化）

修复后，命中数十万行的**宽命中 filteredTotal COUNT 仍随行数线性**（§3.2 表：500k 约 11–12 s）。机制：records 覆盖索引外层驱动需对大表大部分活行逐行做 rfi 主键回表探测并计数，这是"统计一张表的大部分"的固有成本，非 §3.2 那类可由改计划形状消除的缺陷。

交互**首页取页不受影响**：createdAt 覆盖索引 + `LIMIT 101` 短路，宽命中下首页恒定 5 ms（修复前宽命中首页取页曾达 24–25 s）。

潜在优化为 rfi-only 计数（以 rfi 侧计数消除对 records 的逐行回表），但须**先核实软删记录的 rfi 行是否随删除同事务清理**，以保证软删/恢复场景的计数一致性；该一致性未核实前不得改计数路径。此优化登记为 **S5b 之后的独立候选片，本轮不做**，不改变 §6 S5b 顺序。

上述 500k 时延来自项目总监本机（M5/16G，非规格机）E3 手动观察，仅供方向参考、不得进入阈值裁决；§8 T1 的判定只认 4C8G+SSD 规格机 best-of-5 的 E1 数据。

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

## 5. 5000 行 / C=8 harness 连接层：失败轮（5.1–5.3，E2 历史）与闭环轮（5.4，E1 留证）

> **本节为两段式**：5.1–5.3 是 2026-09-13 14:13 失败轮的原始账目与 T0 三条件定义（保留为根因分析输入）；**5.4 是同日晚些时候慢查询消除后的闭环轮，#84 据 5.4 判闭环**。5.3 中"#84 待实现、拟 undici Agent 池化"的**选型假设已被四审证伪**：真因是高命中慢查询经 better-sqlite3 同步调用全程阻塞事件循环，而非 undici 连接池容量不足；慢查询消除后未加任何 Agent 池/队列/背压即满足 T0。读 5.3 时须以本注与 5.4 为准。

### 5.0 失败轮产物（E2，历史）

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

审计方法见附录 B。零依赖对账器已随任务 #84 收尾入库为 **`apps/api/scripts/bench/audit-server-log.mjs`**（commit `e9916da`，附 `__tests__/audit-server-log.test.ts`），exit 0=t0Pass、exit 2=有尾挂/失败；早期草稿曾拟 `.py`，以实际入库的 `.mjs` 为准。

- 读库 home（无 viewId）：540 进 / 540 出 / 0 尾挂（539 个 200 + 1 个 400）；
- 读库 view/search（带 viewId）：82 进 / 74 出 / **8 尾挂**，尾挂全部属于最后 C=8 同 viewId（`view_scn...5cwg0`）一批，落在日志 1232–1241 行——客户端放弃等待，非服务端挂死；
- 写库：250 个 POST 全 201；另有 5 个 GET 写后校验，末行在 teardown 时被截断。

### 5.3 定性与处置（失败轮，历史；选型假设置 5.4 已证伪）

该轮证据证明的是 **harness 在 C≥8 下客户端连接层雪崩**，不是 SQLite 容量或 hydration 正确性问题；因此 5k C=8 失败轮不产出任何性能裁决。失败轮曾假设根因为"undici 连接池/队列/背压不足"，拟为 load 侧引入显式 undici Agent；`apps/api/scripts/bench/load.ts` 的 catch 早期只置 timedOut、吞掉 error 对象。

**四审更正（2026-09-13）**：① 沿 `error.cause` 链提取传输层错误码的 `errorCode()` 已落地（`load.ts:52-61`），逐采样记录 `ECONNRESET` 等，归因可核；② 真因不是连接池容量，而是高命中物理查询全量物化/相关 EXISTS 致单请求 7–20 s，better-sqlite3 同步调用全程阻塞 Node 事件循环，C=8 排队请求的 keep-alive 空闲连接超服务端 `keepAliveTimeout` 被半关，undici 复用死连接即 `ECONNRESET`（client <1 ms、serve=0、physicalSql/prismaCalls=0）；③ 慢查询由 #94（`e656abb` 钉多 JOIN 计划形状）等消除后，闭环轮（5.4）在**未加任何 undici Agent 池/队列/背压**下即满足 T0 三条件。undici Agent 池化降级为可选韧性项，**不再是 T0 前置**。

**T0 解锁三条件（全部满足后 C≥8 数据才可进入性能门）**：

1. 服务端 `<--` 请求计数 == 客户端"成功发送"计数；
2. status=0 样本归零；
3. 目标并发下 harness 自身连接失败率 = 0。

### 5.4 闭环轮（E1 留证，#84 判闭环依据）

慢查询消除后，在**全新生成的干净 5k 库**（不复用失败轮写污染库）按 §5 原参数重跑**全量默认场景矩阵（19 场景，未用 `--scenes` 裁剪）**，留证 `docs/baseline/2026-09-13-m1-s10-t0-closure-multinum.md`（commit `53b3663`，E1；产物 `t0-rerun-on-c8-full.{json,read,write}.server.log` 为 E2 gitignored）。参数：C=8 / warmup 50 / samples 200 / limit 100，flags read/keyset/prefetch 全 on，全量含新增多数值字段宽命中 AND 场景 `filter_range_multi_num`。

结果（项目总监独立跑 `audit-server-log.mjs` 对两日志对账、解析 gate JSON 逐项核对）：

| 口径 | 数 |
|---|---|
| 全量 19 场景采样 | 3,601，failures=0、timeouts=0、每场景 `errors={}` |
| read 日志 home 流 | 进 501 / 出 501 / 尾挂 0（200×500，400×1） |
| read 日志 view-search 流 | 进 3,500 / 出 3,500 / 尾挂 0（全 200） |
| write 日志 home 流 | 进 120 / 出 120 / 尾挂 0（全 200） |
| write 日志 POST 流 | 进 350 / 出 350 / 尾挂 0（全 201） |
| 写后对拍 | sidecarDrift=0、shadowDrift.count=0 |

唯一非 2xx 为 `deep_window_edge` 对 keyset-on 超窗 offset=600 的预期 400（n=1，该场景 failures=0）。多 JOIN 场景 `filter_range_multi_num` 200 采样 0 失败、physicalSqlAvg=3（证走真多 rfi JOIN 非回退）、serve P95=1,374.61 ms。T0 三条件全部满足，**#84 闭环、harness 在 C=8 可信**。run-gate 退出码 2 仅来自 7 条读 P95≥1,500 ms 的 **T3/应用层** breach（sort_number_desc/sort_select_text/filter_and_or_residual/aggregations/group_by_select/search_short/search_word3，全部 failures=0、prisma 约 14,030–14,320 次/请求），属 §4 应用 hydration/内存计算成本、归 S5b（#89），**不记 #84、不属连接层、不动"物理索引层 pass / 不迁 PG"结论**。

## 6. 裁决

1. **本轮不触发 ADR-0008，不立项迁 PostgreSQL。** 物理索引层按 §3 分三形态：窄命中 range/等值在 50 万行亚毫秒~毫秒（§3.1，E1 pass）；多字段高命中 AND 多 JOIN 是计划形状缺陷、已由 `e656abb` 修复并有 EXPLAIN 形状测试防回归（§3.2，E1 修复，前后对比时延为 E3 待规格机复核）；宽命中 filteredTotal COUNT 随行数线性（500k 约 11–12 s，E3）是登记在案的后续优化边界、首页取页恒定 5 ms，非缺陷、非迁库依据（§3.3）。端到端慢点定位于应用层两类独立成本（§4），切库不改变取数形状。
2. **S10 性能侧维持 INCONCLUSIVE，但范围已收敛。** #84/harness 连接层已闭环（§5.4，T0 三条件满足，C=8 可信），不再是 INCONCLUSIVE 理由；继续 INCONCLUSIVE 的理由仅剩：① 治理 C-compute 的 S5b-Ⅱ 字段投影器尚未上线、应用层手段未穷尽（§4/§6.3）；② 端到端 T3 亚秒在 7 个应用层场景仍 breach（§5.4，归 S5b）；③ 100 万行终验待固定规格机（4C8G+SSD）best-of-5。物理层窄命中结论为 pass（§3.1），多字段计划形状缺陷已修（§3.2，E1）；§3.3 宽命中 COUNT 线性为 E3 本机观察，不进入本轮裁决、不构成迁库依据，其 rfi-only 计数优化列 S5b 之后独立候选片。
3. 应用层未完手段拆为两个独立切片，各自独立 flag / 对拍 / 度量，**不得互相冒领收益**（文件级实施计划另文送审，本节只锁定边界）：
   - **S5b-Ⅰ prefetch 边剪枝**：按"被引用 link 字段闭包"过滤 `expandLevel` 的 groups（治 C-io/oof）。度量只允许声称：被剪边本会 `loadGroups` 的 link 行数、prefetch recordCache 峰值/RSS、prefetch-on 下 home 墙钟与 prisma 调用数。**不得**声称降低点引用 CPU 或达成任何 CPU 时延目标。红线：展示用 links/subtable 列的对端 LinkRef 永远解析（`resolveForwardLinks`/`resolveReverseLinks` 不剪）。
   - **S5b-Ⅱ 字段投影器**：点引用分支只解析被引用子字段的最小依赖闭包，替代整记录 `buildFirstPassMerged + computeFormulas`（治 C-compute）。度量：cpu-prof 中 `getMergedCached`/`buildFirstPassMerged`/`computeFormulas` 自身耗时下降、点引用路径 prisma 调用数随"被引字段闭包"而非"30 字段 × link 数"变化；214+ hydration 逐值对拍、环基线 on 态逐值全等、shadow drift=0。§4.1 的 CPU 时延改善预期归属本片，且数值必须由 cpu-prof 证实/证伪。
   - 顺序：**P0 #84（harness）已闭环（§5.4）** → 点引用环语义 characterization（非对称环 A→B→A 不同起始根逐值基线，现测试仅覆盖双侧 null）→ Ⅰ/Ⅱ 实现；先做哪片以 characterization 后的 cpu-prof 归因数据为准。**在 S5b-Ⅱ 落地、或 cpu-prof 用数据证伪 C-compute 主导性之前，本 ADR 不得声称应用层手段已穷尽，也不得据 hydration 指标谈迁 PG。**

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

- S10 性能侧 INCONCLUSIVE 意味着 100 万终验与容量签核延后；harness 连接层（#84）已闭环，剩余依赖为环 characterization、S5b-Ⅱ 与固定规格机；
- S5b-Ⅱ 触碰 `hydrate.ts` 点引用核心路径，须在 214+ 既有 hydration 对拍之外补非对称环基线，评审通过前不得实施；
- 500k 端到端 OOM 形态未抓到显式退出标记，固定规格机复跑时须同步采集系统 OOM/jetsam 证据闭环。

## 附录 A：证据清单与复跑命令

| 证据 | 级别 | 位置 / 复跑 |
|---|---|---|
| S10 门报告（物理层/扇出/三 fixup/质量门） | E1 | `docs/baseline/2026-09-13-m1-s10-gate.md`（`413f4a2`） |
| BFS 双界 / readyz WAL / 生成器跨批修复 | E1 | commits `7c7b3c0`、`3b6b367`、`22b1fa2` |
| 多字段高命中 AND 多 JOIN 计划形状修复（`INDEXED BY rfi_record_field_ord_key` 强制 records 驱动） | E1 | commit `e656abb`（任务 #94）；EXPLAIN 形状防回归 `apps/api/src/domain/queryPlan/__tests__/countJoinMultiNum.test.ts` |
| §3.2 修复前/后 100k、500k 单/双/三字段高命中 AND 对比时延 | E3 | 项目总监独立实测（better-sqlite3 只读、best-of 预热，M5/16G 本机、非规格机），无报告文件，待 4C8G+SSD 规格机 best-of-5 E1 复核，禁止用于阈值裁决 |
| §3.3 宽命中 filteredTotal COUNT 线性（500k 约 11–12 s）、首页取页恒定 5 ms | E3 | 同上项目总监本机观察；rfi-only 计数优化（须先核实软删 rfi 行是否随删除同事务清理）列 S5b 之后独立候选片，本轮不做 |
| 5k C=8 harness 客户端结果 | E2 | `artifacts/bench/5000-c8-on.json`（gitignored，§5 复跑命令） |
| 5k C=8 服务端读写日志 | E2 | `artifacts/bench/5000-c8-on.{read,write}.server.log` |
| 7k v_range 14.1 s/prisma 214、C8 85 s | E3 | 手动观察，待固定规格机重测，禁止用于裁决 |
| 100 万行终验 | — | 不硬跑、不伪造；待 4C8G+SSD 与 S5b-Ⅱ 后执行 |
| harness C≥8 连接层 #84 闭环轮（19 场景/3,601 采样 0 失败，FIFO 全 0 尾挂） | E1 | `docs/baseline/2026-09-13-m1-s10-t0-closure-multinum.md`（`53b3663`）；根因为慢查询同步阻塞事件循环而非连接池，未加 undici Agent 即达 T0（§5.4） |
| harness 失败轮结果（5k C=8，625/2,576） | E2 | `artifacts/bench/5000-c8-on.json`（gitignored，§5 复跑命令）；历史根因分析输入 |
| 服务端日志 FIFO 对账器 | E1 | `apps/api/scripts/bench/audit-server-log.mjs` + `__tests__/audit-server-log.test.ts`（`e9916da`），exit 0=t0Pass，T0 自动化对账工具 |
| S5b-Ⅰ/Ⅱ 文件级实施计划 | Proposed 终审稿 | `docs/planning/phase2/S5b-hydration-projection-plan.md`（任务 #93 已送总监终审；评审通过前不派单、不写生产代码） |

数据生成复跑：

```bash
DATABASE_URL=file:/abs/bench-<n>.db pnpm tsx apps/api/scripts/bench/gen-data.ts \
  --rows <n> --shape wide --seed 20260913 --manifest /abs/bench-<n>.manifest.json
```

## 附录 B：服务端日志审计方法

对 `*.server.log` 按连接内顺序做 `<--`（进入）/`-->`（响应）FIFO 配对：先按登录态与 path 分 home（无 viewId）/ view-search（带 viewId）/ write（POST）三流，各自统计进入数、响应数、按状态码分桶、以及流末无配对的尾挂行号；尾挂须回查同批 viewId 与客户端 samples 时间窗，区分"服务端挂死"与"客户端放弃"。5000-c8-on 的本账目（home 540/540/0、view 82/74/8、write 250 POST 全 201 + 5 GET 校验）已经项目总监**三审独立复核**：对 `5000-c8-on.json` 逐场景重算 3201/625/2576，并对 `5000-c8-on.read.server.log` 按行序 FIFO 配对独立得出 home 540/540/0、view 82/74/8，与本 ADR 一致。该复核仅覆盖第 5 节日志/采样账目，不等于全文终审；全文转 Accepted 以项目总监提交后终检为准。可复跑的脚本化对账器随 #84 入库，作为 T0 的自动化对账工具（入库前此口径以人工 FIFO 复核为准）。

---

## 10. 2026-09-12 NAS 重定向修订

> **本修订由项目总监 92d0a34 决策驱动**（依据：`docs/planning/phase2/PLAN-ADJUST-nas-min-hardware.md`，2026-09-12 项目总监自裁决 Accepted），不是架构师自行翻状态或自行"追认"。**本 ADR 状态仍为 Accepted，覆盖范围同原状态行（仅物理索引层与 T0 连接层结论；不新增百万行终验结论）；不重开迁库结论，作者未自行把任何 INCONCLUSIVE 项置为已定。** 本节只按总监决策重写 T1 的触发口径、降级大规模数字的地位、登记延后候选；§1–§9 与附录原文保留（其中"待 4C8G+SSD 规格机 best-of-5 复核"类表述以本节为准解读）。

### 10.1 T1 按 PLAN-ADJUST §5.3 硬件无关改写（替代 §8 表中 T1 的规格机半句）

§8 表中 **T1 原口径**："固定规格 4C8G+SSD 上物理索引命中场景 100 万行 P95 仍 ≥1.5 s（best-of-5 中 ≥3 轮），或默认首页 ≥800 ms（真实工作负载，连续观察）"。自 2026-09-12 起，该"固定规格机 + 人造百万行 + best-of-5"半句**作废**，T1 改为**硬件无关的相对/症状触发**（PLAN-ADJUST §5.3 原文口径）：

> 在 A1/A2/A4/A5/A6 及 hydration 收口（S5）已上线、sidecar drift=0、EXPLAIN 无 SCAN、计算字段已按规置灰、**且已完成调索引 / 调 bound / 升 better-sqlite3 等二次尝试**的前提下，于**真实部署机（含最低参考机 Tier-L：2C4G / 机械盘或典型 NAS 网络盘）**上出现下列任一**持续症状**（非压测瞬时尖峰、非 best-of-5 单轮）：
>
> 1. 代表性**真实日常工作负载**（不是人造百万行）的默认列表 / 命中筛选延迟持续超出用户可接受区间（连续观察）；
> 2. 列表 RSS 持续触顶并引发 OOM / 被系统杀；
> 3. A6 串行化后仍出现写排队超时；
>
> 方可立项议迁 PostgreSQL。单纯"计算字段 / 全文搜索慢"或"人造百万行宽 COUNT 慢"仍不触发。

**T0、T2、T3、T4、T5 维持不变**（它们本就与规格机无关）：T0 harness 可信度三条件、T2 单表活跃行 >1000 万、T3 单库 >100GB、T4 峰值写持续 >100 QPS 或串行化后仍写排队超时、T5 多实例/HA/多租户 SaaS 形态，继续按 §8 表执行。§8 表后"先出调索引/调 bound/升 better-sqlite3/完成 S5b 剩余片的二次尝试清单再谈迁库"的纪律保留，且"完成 S5b 剩余片"一项以本 ADR §10.3 的 S5b-Ⅱ 证伪后移为准重新解释。

### 10.2 50 万 / 100 万 best-of-5 数字从"放行硬门槛"降级为"参考画像"

- §S10 旧硬门（"50 万 P95<800ms、100 万<1.5s，best-of-5 ≥3/5 轮"）**不再是 M1 放行条件，也不再是 T1 的必要条件**。
- 在任何可得硬件上跑出的 50 万 / 100 万数字（含 §3 已留证的 M5/16G 本机 E3 数据）一律作为**参考画像（profile）**使用：必须标注机型 / CPU / 内存 / 盘型（SSD/HDD/NAS 网络盘）/ 冷热缓存，**不作统一对客毫秒承诺、不跨机型套用**。
- 新放行基线为 PLAN-ADJUST §5.2 的 **Tier-L（2C4G/慢盘）DoD**：小规模（1k/1万/10万）真实可用 + EXPLAIN 无 SCAN + 内存有界 + 大表有界降级 + 并发写零 BUSY + flag 可一键回退 + 平台中立。run-gate / gen-data / audit-server-log 工具保留，但常规回归只跑 1k/1万/10万；50 万/100 万改为可选、谁需要谁在自己机器上跑，不阻塞里程碑。
- bound 默认按 Tier-L 保守设定并可配（PLAN-ADJUST §5.2 建议起点：`GX_M1_GROUP_BOUND=5000`、`GX_M1_INMEM_LIMIT=20000`、网格默认页 100–200；**以上为建议起点，待 Tier-L 实测回填，不是拍板阈值**）；读路径在 Tier-L 完成 shadow drift=0 + 内存有界验证后默认置 keyset+sidecar 读 on（异常自动回退旧路径保持）。

### 10.3 延后候选登记（按规模触发，本期不投入）

以下三项由 PLAN-ADJUST §2.3 正式登记为"**按规模触发的延后候选**"，从 M1/S10 的未决依赖中移出，不影响"不迁 PG"结论：

| 项 | 原位置 | 处置 | 触发再做的条件 |
|---|---|---|---|
| **S5b-Ⅱ 字段投影器（治 C-compute）** | §4.1、§6.3 | **前提已被证伪，正式后移**：P2 本机 cpu-prof 归因显示点引三函数 self 合计仅占 busy **1.15%**，真热点为 idle 等 IO（约 45%）与 parseStored 等（见 `docs/baseline/2026-09-14-s5b-cpuprof-attribution.md`，E1）。为 1.15% 重写点引用核心路径在低配小数据集上零可感收益、高回归风险。 | 真实 100k+ mega-hub 宽表负载下 cpu-prof 复现 C-compute 主导热点；接口（hydration 两阶段 + mergedCache）不变，届时按 S5b 计划纯增量实施。 |
| **S5b-Ⅰ prefetch 边剪枝（治 C-io/oof）** | §4.2、§6.3 | **延后**：收益（少查无引用关系的 ownerLink 行）在 10k 小表测不出，仅 100k/500k mega-hub + 高并发下显著，NAS 初期数据量小。注意勿混淆开关：已交付的 S5 **有界批量预取本身默认常开**，其生产开关真名是 **`GX_HYDRATE_PREFETCH`**（`apps/api/src/domain/hydrate.ts:90-92`，`!== "off"`，prod/dev/test 默认 on；depth=3、预算夹 [400,2000]、预算外 cache-miss 逐值兜底保取值等价）——该有界预取**保留、不在后移范围**；后移的只是"边剪枝"这一增量。 | 出现 100k+ mega-hub 真实负载或 cpu-prof 复热点；剪枝开关 `GX_HYDRATE_PRUNE` 仅是 S5b 计划中**尚未实现**的未来 flag 规格（见 `S5b-hydration-projection-plan.md`；生产代码当前不存在该开关），实现为加一个被引字段闭包过滤，纯增量；展示列 LinkRef 不剪的红线保留。 |
| **第三类成本：展示列 LinkRef 标题物化**（buildLinkRefs/primaryTitle，inclusive 24–30%） | §4（应用层成本补充登记） | **登记不做**：为显示关联标题逐 id 取标题的成本量级真实，但只在大 hub 显现，属优化项非正确性项。 | 同规模触发；未来走同一 BatchStore 批量取标题/缓存，增量。 |
| **宽命中 filteredTotal COUNT 的 rfi-only 计数优化**（§3.3，500k 约 11–12s 线性） | §3.3 | **延后**：只在"统计一张表大部分行"时线性，首页 keyset 恒定 5ms 不受影响；NAS 初期无 50 万行宽命中统计。动计数路径前**仍须先核实软删 rfi 行随删同事务清理**（§3.3 原前置条件不变）。 | 真实客户出现宽命中大表统计诉求；独立候选片，不影响首页/分页。 |

### 10.4 本节与原文冲突时的读法

- §3.2/§3.3/附录 A 中"待 4C8G+SSD 规格机 best-of-5 E1 复核""§8 T1 只认规格机 best-of-5 E1 数据"等表述：规格机复核**不再是任何结论的前置**；已有的 E3 本机数字可作方向性参考（决定做不做某优化），只是不写成对外毫秒承诺。
- §6.2 第③项"100 万行终验待固定规格机 best-of-5"与 §9 负面项中"100 万终验与容量签核延后（依赖固定规格机）"：按 §10.2 降级——百万终验绑定高性能规格机，与本期最低硬件目标不符，改为有真实客户接近该规模时再按画像流程跑；T2/T3 仍兜底。
- §6.3 关于"S5b-Ⅱ 落地或被 cpu-prof 证伪前不得声称应用层手段已穷尽"：**已由 2026-09-14 cpu-prof 归因（1.15%）证伪 C-compute 主导前提**，S5b-Ⅱ 据此正式后移；"应用层手段已穷尽"在本期口径下＝Tier-L DoD（索引/bound/hydration 批量化与预算/有界降级/二次尝试清单）达成，不以 S5b-Ⅱ 落地为条件。
