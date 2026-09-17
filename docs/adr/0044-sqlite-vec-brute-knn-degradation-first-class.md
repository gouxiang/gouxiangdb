# ADR-0044：sqlite-vec 暴力 KNN 与"降级一等公民"

**状态（Status）**：Accepted（M5 计划 §11 第 3 条、§4.2/§4.9 定稿；spike-sqlite-vec §1/§2/§8 实测；S13 Tier-L 真机门已取证；2026-09-17 M5 出口归档）
**作者**：架构师 高见远（M5-S14 归档；真机数据由项目总监亲跑、后端 贝洛奇 归档）
**上游依据**：M5-implementation-plan.md §4.2（BigInt 铁律 :315-321）、§4.9（降级矩阵 :495-509）、§13（规模门 :734）、§11（:709）；spike-sqlite-vec.md §1/§2/§5/§8
**关联**：ADR-0042（独立 search.db 连接）；ADR-0045（embedding 仅远端）；ADR-0047（FTS/trigram 与降级路）；ADR-0008（容量证伪门方法论）

---

## 1. 背景（Context）

M5 的向量召回选型在 spike 阶段判定 sqlite-vec 0.1.9【有条件可行】：better-
sqlite3@13 直接支持 `loadExtension()`（无需自编译/无 enableLoadExtension
开关），vec0 加载、1536 维 KNN、与 Prisma 主库并存全部实测通过。但 vec0
**不提供 ANN（近似最近邻）索引**，其 KNN 是对索引内全部向量的**暴力全扫**。
因此必须同时回答两个问题：(a) 如何在绑定/打包层面用对 vec0；(b) 暴力扫的
容量边界在哪、越界后产品如何不翻车。

## 2. 决策（Decision）

### 2.1 采用 sqlite-vec vec0 暴力 KNN，不引 ANN

MVP 阶段向量本地 KNN 直接用 vec0，不引入 LanceDB/FAISS 等 ANN 后端。元数据
等值过滤（entityType 等）在暴力扫描期完成（语义=过滤后集合内 top-k，不加
成本）。KNN 通过 `rowid IN (SELECT rid FROM allowed)` 白名单子查询把权限
收敛压进扫描约束（非全量召回后过滤，见 ADR-0046；S11 EXPLAIN 留证）。

### 2.2 三条绑定铁律（BigInt / BLOB / LIMIT）

1. **BigInt**：vec0 rowid 与所有 integer 元数据列（entityType 1/2/3 映射）
   插入一律 `BigInt(...)`。better-sqlite3@13 把普通 JS number 绑成 SQL REAL，
   vec0 严格要求 INTEGER，传 number 报 `Only integers are allowed for
   primary key` / `Expected integer ... received FLOAT`，整批事务回滚。三处
   对齐 rowid 统一经纯函数 `toRowId()`，由单写者在写事务内用 index_meta
   `next_rowid` 取号。
2. **BLOB**：向量绑定用 `Buffer.from(Float32Array.buffer)`（小端 float32），
   禁 JSON 数组文本。
3. **LIMIT**：所有 KNN 语句必须 `LIMIT ?`/`k=?`，封装层强制；code review
   grep `MATCH ?` 附近无 LIMIT 打回。

### 2.3 原生打包与文件名

- sqlite-vec 0.1.9 主包不含二进制，经平台 optionalDependencies 子包分发，
  运行时 `require.resolve('sqlite-vec-<os>-<arch>/vec0.<ext>')` 取路径；
  `resolveVecPath()` 优先 `GX_VEC_EXT_PATH`，否则按 platform/arch（必要时判
  libc）拼 `${appDir}/native/<triplet>/vec0.<ext>` 绝对路径。
- **文件名恒为 vec0**：入口符号由文件名推导，改名 `myvec0.so` 加载即报
  `dlsym: sqlite3_myvec0_init: symbol not found`（spike §5.3 实测改名坑）。
- **glibc、非 musl**：vec0 x64 需 glibc ≤2.14、arm64 ≤2.17；Docker 基准
  node:22-bookworm-slim，runbook **禁 alpine/musl**（vec0 无 musl 版）。

### 2.4 降级是一等公民（加载失败即 FTS+LIKE）

vec0 缺失/加载失败/改名/musl 一律 catch（不阻断主服务启动），
`vecAvailable=false`，不建/不查 vec_chunks，检索自动回 FTS/LIKE，status/
warn/审计报 `vec_unavailable`。可降级资产**不挂 /readyz**（低端 NAS/musl
预期就是纯 FTS 服役，列入 readiness 会误摘流）。cloud 故障/dim 不符的降级
矩阵见 §4.9，向量可用性为"与门"（mode=cloud 且配置齐 + health ok + vec0
已加载 + dim 一致，任一不满足回 fts/like）。

## 3. S13 真机容量证据（2026-09-17，Tier-L x86_64）

来源 `docs/baseline/2026-09-17-m5-gate-tierL.md`。**参考画像，非硬 500ms
承诺。** 真机：x86_64，2 vCPU Intel Xeon E3-1220 v6 @3.00GHz，MemTotal
5926 MiB（运行期可用 ≈3966 MiB），root ext4，Ubuntu 22.04.5 / glibc 2.35，
Node v22.22.1，sqlite-vec 0.1.9 linux-x64 加载 OK。

### 3.1 hybrid（FTS+vec+RRF/boost）p95，scope-cap 5000 最坏上界，rounds=10

| 档（chunk×dim） | hybrid p95 | 分段 fts / vec (ms) | 峰值 RSS | search.db |
|---|---|---|---|---|
| 1k×512/1024/1536 | 25.9 / 20.6 / 26.6 ms | 4.9 / 19.1（512 档） | 105/112/125 MiB | 3/5/7 MiB |
| 10k×512/1024/1536 | **646.2 / 642.1 / 677.1 ms** | 152.4 / 461.1（512 档） | 139/160/161 MiB | 26/46/66 MiB |
| 100k×512/1024/1536 | **14571.5 / 14699.5 / 15033.7 ms** | 3652.6 / 10770.3（512 档） | 179/184/187 MiB | 252/448/644 MiB |

- 单维 512 三点常被口述为 **1k≈20ms、10k≈0.65s、100k≈14.6s**。
- 线性外推可流畅上限（p95≤500ms，主维 512）≈ **6476 chunk**；舒适区
  **≤2–3k chunk**。

### 3.2 瓶颈归因（决定哪些杠杆无效）

1. **dim 几乎不影响时延**：512/1024/1536 三档 p95 差 ≤5%。若瓶颈是距离
   计算应随 dim 近线性增长——实测不是；dim 只影响库大小与 RSS。
2. **vec 段主导**：100k 档 vec 10770ms vs fts 3653ms；scope 物化与 RRF
   融合可忽略（≤11ms / ≤0.6ms）。
3. **根因=暴力全扫，成本 ∝ 索引内向量总数 N**（每查另加一次 scope JOIN）。
4. **RSS 有界**：峰值 105 -> 187 MiB（1k->100k），不随 N 线性增长，不是
   内存问题。

### 3.3 杠杆实验（100k×512，rounds=3）

| 杠杆 | p95 | 结论 |
|---|---|---|
| 基线 hybrid | 14572 ms | — |
| 收紧 scope（cap 50/500） | 14097 / 14423 ms | **无效**（0–3%），KNN 全扫与 scope 大小无关 |
| 调 k（k=20） | 14515 ms | **无效**，k 不改全扫行数 |
| 关向量（mode=fts） | **3670 ms** | **有效 ≈4×**，但 100k 仍超阈值 |
| 降 N（chunk 总量） | 按构造 ∝ N | **唯一真正有效的杠杆** |

10k 档同向：hybrid 646ms -> fts-only **151.9ms（达标）**。两条负结论显式
登记防重复踩：**收紧 scope 无效、调 k 无效**；低端设备建议调低
`fieldChunkCap`（record 宽表 field chunk 占多数）。

### 3.4 升级触发条件（口径更新）

计划 §11/§13 原口径："chunk > 50 万 **或** 真机 P95 持续超标 -> 走 LanceDB
ADR"。本次 S13 **已命中"真机 P95 持续超标"分支**（hybrid 路 10 万级
≈14.6s，远超 500ms 目标，且证明收紧 scope/调 k 均无法缓解）。

据此：**ANN（LanceDB 或等价）评估登记为下里程碑 ADR 候选，本里程碑不实施。**
登记题：「低端设备上 10 万级语义检索的 ANN 评估（LanceDB / 或等价 ANN）」
（0051–0055 编号留给 M6，由 M6 排期落笔，本 ADR 不占编号）。本里程碑发布
姿态不受影响（见 3.5），避免后人误以为升级门从未触发。

### 3.5 本里程碑发布姿态（有条件降级发布）

- 生产默认 `GX_M5_SEARCH=off`、`GX_EMBEDDING_MODE=off`；语义检索为管理员
  显式配置 + 二次确认才启用。
- Tier-L 低端设备默认关键词路（`GX_EMBEDDING_MODE=off`，fts-only 100k
  ≈3.7s、10k ≈0.15s）；启用语义路前评估工作区 chunk 总量（≤2–3k 舒适）。
- **不引入自动降级 guard**（会改 `degraded[]` 冻结枚举与行为契约）；改为
  指引式（baseline + runbook §7 + 设置面板提示）。

### 3.6 必须如实记录的三条边界（不得美化）

1. 真机 MemTotal **5.9GB 略宽于 Tier-L 的 4GB 目标**，内存维度属"略宽松"
   样本，4GB 机器应更保守。
2. 系统盘 **`rotational=1` 报告为机械盘，但宿主真实介质未知**（虚拟化层常
   回报 1）-> 磁盘维度结论**偏乐观、待复核**；本报告时延以 CPU/单线程扫描
   成本为主，若确为 HDD（更慢随机 IO）时延会更差。
3. **arm64 未做真机【未实测】**：用户 2026-09-17 授权对计划"x86 与 arm
   各一台"的偏离，本次仅提供 x86_64 VM；arm64 仅保留 CI 交叉构建冒烟
   （linux/arm64 加载 vec0 + 1 次 KNN），**性能数字未实测，不得以 x86 数字
   近似冒充 arm**。

## 4. 被否决的备选

1. **本里程碑上 ANN（LanceDB/FAISS）**：引入新原生/进程依赖与运维面，与
   MVP 单机部署不相称；在 ≤数千 chunk 舒适区 vec0 余量充足。但 S13 已证明
   10 万级暴力扫不可接受，故不是"永不升级"，而是登记为下一里程碑候选。
2. **加载失败仍强行向量路 / 让启动失败**：低端 NAS/musl 是预期场景，扩展
   投放失败不得阻断主服务；定稿 catch 后纯 FTS 服役。
3. **number 绑定 / JSON 向量 / 无 LIMIT KNN**：分别触发 vec0 类型错误、
   性能与兼容问题、无界扫描；三铁律进 code review 与单测。

## 5. 后果（Consequences）

- 语义检索容量在 Tier-L 级机器上以"chunk 总量"为硬约束（≤2–3k 舒适，
  外推上限 ≈6.5k）；容量规划与 `fieldChunkCap` 默认建议以此为准。
- 产品必须提供确定性降级提示（mode/degraded、设置面板）与关键词路兜底；
  不得对混合路 p95 作跨硬件 500ms 承诺。
- 后续在低端设备支撑 10 万级语义检索需走 ANN 评估 ADR；EmbeddingProvider/
  indexer 接口保持不变以使替换面收敛（ADR-0042）。

## 6. 验证证据

- 绑定/加载/打包：spike-sqlite-vec.md §1（loadExtension）、§2（BigInt）、
  §5（平台子包/改名 dlsym）、§8（容量与连接）。
- 真机规模：docs/baseline/2026-09-17-m5-gate-tierL.md（§1 画像、§2 矩阵、
  §3 归因、§4 杠杆、§6 发布结论、§7 arm64 缺口）。
- 小规模 EXPLAIN/SQL 常量化：docs/baseline/2026-09-17-m5-gate.md §1/§2
  （vec 路 `SCAN vec_chunks` + `LIST SUBQUERY` + temp_scope 覆盖索引）。
- 降级矩阵：M5 计划 §4.9；AC-M5-1 对抗见 M5-S12。
- 复现：apps/api/scripts/bench/m5-gate.ts（`--mode/--k/--scope-caps`）。
