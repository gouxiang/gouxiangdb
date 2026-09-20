# M5 统一检索 - S13 真机规模门（Tier-L x86_64 2C4G）参考画像与降级发布结论

- 日期：2026-09-17
- 里程碑：M5（向量库与统一检索）S13「规模与真机门」
- 作者：后端 贝洛奇（真机数据由项目总监在用户提供的 VM 上亲跑；本机 arm64 复现对照由后端补）
- 性质：**证据文档 + 压测器能力补全**。不改任何生产语义（处置为文档/指引，非改代码）。
- 实施依据：`docs/_archive/originals/planning-phase2-M5-implementation-plan.md` §13（规模门，Q2 参考画像口径）、§0.4（超档发布姿态）、
  §7 S13 行；`PLAN-ADJUST-nas-min-hardware.md` §5.1/§5.2（Tier-L 定义与放行准则）。
- 复现入口：`apps/api/scripts/bench/m5-gate.ts`（本片新增 `--mode/--k/--scope-caps` 三个杠杆参数）。
- 相关：§4.9 降级矩阵、`docs/baseline/2026-09-17-m5-gate.md`（S11 EXPLAIN/SQL 计数）

> **口径声明（先读）**：本文件给的是**参考画像**，**不是硬 500ms 承诺**。结论为**有条件降级发布**：
> 关键词路达标，hybrid/vector 路仅在受控容量内达标。生产默认姿态**不受影响**（见 §6）。

---

## 1. 机器画像（真机）

| 项 | 值 |
|---|---|
| 架构 / CPU | x86_64，2 vCPU，Intel Xeon E3-1220 v6 @ 3.00GHz |
| 内存 | MemTotal 5926 MiB，运行期可用 ≈3966 MiB |
| 系统盘 | root ext4 `/dev/sda3`，可用 118 GB，**`rotational=1`（按设备属性报告为机械盘）** |
| OS / libc | Ubuntu 22.04.5 LTS，glibc 2.35 |
| Node / pnpm | Node v22.22.1 |
| sqlite-vec | 0.1.9 `linux-x64` 加载 **OK** |

**画像口径提醒（勿过度外推）**：

- 内存实际 5.9 GB **略宽于 Tier-L 的 4 GB 目标**——本报告内存维度属"略宽松"样本；4 GB 机器上应更保守。
- `rotational=1` 报告机械盘，但**宿主真实介质未知**（虚拟化层常回报 1）→ **磁盘维度结论偏乐观/待复核**：
  本报告时延结论以 **CPU/单线程 SQLite 扫描成本**为主，磁盘若确为 HDD（更慢随机 IO）时延会更差。
- arm64 **未做真机**（仅 CI 交叉构建冒烟）；见 §7。

---

## 2. 全量矩阵（scope-cap 5000 = 最坏上界，rounds=10，hybrid = FTS+vec+RRF/boost）

EXPLAIN 全部 OK（vec：`LIST SUBQUERY` + `temp_scope`；fts：`temp_scope`）；每次召回 hits fts=100 / vec=100。

| 档 | p95 (ms) | 分段 scope / fts / vec / fusion (ms) | 峰值 RSS | search.db |
|---|---|---|---|---|
| 1k×512 / 1024 / 1536 | 25.9 / 20.6 / 26.6 | 0.8 / 4.9 / 19.1 / 0.56 | 105 / 112 / 125 MiB | 3 / 5 / 7 MiB |
| 10k×512 / 1024 / 1536 | **646.2 / 642.1 / 677.1** | 4.7 / 152.4 / **461.1** / 0.39 | 139 / 160 / 161 MiB | 26 / 46 / 66 MiB |
| 100k×512 / 1024 / 1536 | **14571.5 / 14699.5 / 15033.7** | 10.9 / 3652.6 / **10770.3** / 0.34 | 179 / 184 / 187 MiB | 252 / 448 / 644 MiB |

- 线性外推可流畅上限（p95 ≤ 500ms，主维 512）≈ **6476 chunk**（参考画像）。
- **Tier-S（1万–10万，初期 NAS 真实区间）超阈值**：最差 15033.7 ms vs 目标 500 ms。

---

## 3. 分段归因（瓶颈定位）

1. **dim 几乎不影响时延**：512/1024/1536 三档 p95 差 ≤5%（10k：646/642/677；100k：14572/14700/15034）。
   若瓶颈是向量距离计算，应随 dim 近线性增长——**实测不是**。dim 只影响库大小（10k：26/46/66 MiB；100k：252/448/644 MiB）与 RSS。
2. **vec 段主导**：10k 分段 vec 461ms / fts 152ms；100k 分段 vec 10770ms / fts 3653ms。scope 物化与 RRF 融合可忽略（≤11ms / ≤0.6ms）。
3. **根因**：vec0 **无 ANN**，KNN 为**暴力全扫**，成本 **∝ 索引内向量总数 N**（+ 每查一次 scope JOIN）。
4. **内存有界**：峰值 RSS 105 → 187 MiB（1k→100k），**不随 N 线性增长** → **不是内存问题**（压测器流式建库，见 §9）。

---

## 4. 三个杠杆实验（100k×512，rounds=3；已还原临时改动，现由仓库参数复现）

| 杠杆 | 100k×512 p95 | 结论 |
|---|---|---|
| 基线 hybrid（`--mode hybrid`） | 14572 ms | — |
| **收紧 scope**（`--scope-caps 50` / `500`） | 14097 / 14423 ms | **无效**（≈0–3% 收益） |
| **调 k**（`--k 20`，perRoute 100→20） | 14515 ms | **无效** |
| **关向量**（`--mode fts`） | **3670 ms** | 有效（≈**4×**）但 100k 仍超阈值 |
| **降 N**（chunk 总量） | 按构造 ∝ N | **真正有效的杠杆** |

10k 档同向：hybrid 646ms → fts-only **151.9ms（达标）**；scope 50/500 仍 ≈610ms（无效）。

**两条负结论（显式登记，防后人重复踩）**：

- **负结论 1：收紧 scope 无效。** KNN 扫描成本 ∝ 索引内向量总数 N，**与 scope 大小无关**；
  缩小 scope 只减少 allowed 集，不减少 vec0 的全扫行数（scope JOIN 本身 ≈ 10ms 量级，非瓶颈）。
- **负结论 2：调 k 无效。** k 只决定返回多少条，不改变 vec0 暴力扫描的行数（`rowid IN` 是扫描约束但代价仍在全扫）。

> 推论：**唯一有效杠杆是控制 N**（索引内 chunk 总量）。record 宽表的 field chunk 占多数 → 低端设备建议**调低 `fieldChunkCap`**（S9 已支持 config + 需 reindex）。

---

## 5. 容量指引（Tier-L 级机器；参考画像，非承诺）

| 路径 | ≤2–3k chunk | 10k chunk | 100k chunk |
|---|---|---|---|
| hybrid / vector | 舒适（≤~30ms） | ≈0.65 s | ≈14.6 s |
| 关键词（`mode=fts`） | 舒适 | ≈0.15 s **达标** | ≈3.7 s |

- 舒适区（hybrid/vector 达标 p95≤500ms）≈ **≤2–3k chunk**（外推上限 6476 chunk 为单维 512 的上界估计）。
- 初期 NAS 部署建议：**以关键词检索（`GX_EMBEDDING_MODE=off`）为默认**；语义检索在**受控 chunk 量**下启用，
  并用 `fieldChunkCap` 控制 record 派生量。

---

## 6. 降级发布结论（按 §0.4 / §13 姿态）

- **按计划交付，非偏离**：§13 要求"参考画像而非硬 500ms 承诺 + 超档给杠杆证据 + 降级发布结论"；本报告即该交付。
- **生产默认不受影响**：`GX_M5_SEARCH` 默认 `off`、`GX_EMBEDDING_MODE` 默认 `off`；语义检索为**管理员显式配置 + 二次确认**才启用（cloud 出网亦同）。
- **不引入自动降级 guard**：会改动 `degraded[]` 冻结枚举与行为契约，故不做；改为**指引式**
  （本文件 + runbook §7 + 设置面板提示语，属前端/文档范围）。
- **建议发布口径**：Tier-L 低端设备默认关键词路；启用语义路前评估该工作区 chunk 总量（≈ ≤2–3k 舒适）。

---

## 7. arm64 未实测缺口（显式登记）

- 本次用户仅提供 **x86_64** VM；**arm64 不做真机**（对计划原"x86 与 arm 各一台"的**已授权偏离**）。
- arm64 仅保留 **CI 交叉构建冒烟**（linux/arm64 加载 vec0 + 1 次 KNN），**性能数字未实测**，
  在 S14 出口文档标为【未实测缺口】。**不得以 x86 数字近似冒充 arm**。

---

## 8. ADR 候选登记（本里程碑不实施）

按 §13「>50 万 chunk 或真机 P95 持续超标 → 走 LanceDB ADR」：本次**已命中"真机 P95 持续超标"分支**
（hybrid 路 10 万级 ≈14.6s，远超阈值）。故登记 **下里程碑 ADR 候选**：「低端设备上 10 万级语义检索的
ANN 评估（LanceDB / 或等价 ANN）」——**编号与落笔在 S14**，本文件不建 ADR。

---

## 9. 复现（一条命令，含本片新增的三个杠杆参数）

```bash
cd apps/api
# 全量矩阵（默认 sizes/dims，rounds=10）
npx tsx scripts/bench/m5-gate.ts --out /tmp/m5-gate-$(uname -m).json --rounds 10

# 杠杆 1：收紧 scope（一次扫多档，产物按 cap 分档）
npx tsx scripts/bench/m5-gate.ts --sizes 100000 --dims 512 --rounds 3 --mode hybrid \
  --scope-caps 50,500,5000 --out /tmp/m5-lever-scope.json
# 杠杆 2：调 k
npx tsx scripts/bench/m5-gate.ts --sizes 100000 --dims 512 --rounds 3 --mode hybrid \
  --k 20 --out /tmp/m5-lever-k.json
# 杠杆 3：关向量（仅关键词）
npx tsx scripts/bench/m5-gate.ts --sizes 100000 --dims 512 --rounds 3 --mode fts \
  --out /tmp/m5-lever-fts.json
```

参数：`--mode hybrid|fts`、`--k <perRoute 默认100>`、`--scope-caps a,b,c`（或 `--scope-cap N`）。
产物 = JSON + 同名 `.md`。`--force` 覆盖 RAM 守卫（dev/空闲机自测；磁盘守卫不可覆盖）。

### 9.1 本机（开发机 macOS arm64）交叉复现对照（仅证"脚本行为同向"，非 Tier-L 数字）

| 实验（10k×512） | 本机 arm64 | 真机 x86_64 | 方向 |
|---|---|---|---|
| hybrid（cap 5000） | 357.6 ms | 646.2 ms | — |
| 收紧 scope（cap 500） | 367.5 ms | （cap500）14423 ms@100k | **无效**（同向） |
| 调 k（k=20） | 350.0 ms | 14515 ms@100k | **无效**（同向） |
| 关向量（fts-only） | **86.5 ms**（≈4.1× 快） | 151.9 ms（≈4.2× 快） | **有效**（同向） |

> 本机 cap=50 首档偏高（850ms）属 rounds=3 小样本噪声（跑在预热后首档）；结论以 cap 500 vs 5000 对比为准。
> 本机为 arm64，**不得**用作 arm 性能结论（见 §7）。

---

## 10. 边界与纪律

- 本片只动 `scripts/bench/**` 与 `docs/**`；**未改 search/query/权限生产语义**——负结论的处置是文档 + 指引。
- 不提交大数据/临时产物；不建 ADR（仅登记候选）；arm64 不真机、不做数字近似。
