# S5b-P2 本机 CPU profile 结构归因（决定 P3 先做 S5b-Ⅰ 还是 Ⅱ）

- 日期：2026-09-14
- 留证人：后端工程师 贝洛奇
- 任务：顺序门 P2（#98），依据 `docs/planning/phase2/S5b-hydration-projection-plan.md` §0/§1/§3.5/§6/§7.1/§7.3
- 代码基线：`6404aec` 之后的工作树（bench 透传片，未提交时基线为 `6404aec`）；生产构建 esbuild 380.3 KiB（`keepNames:true`，hydrate 函数名保留，可按名聚合）

> **证据等级声明（最重要）**：以下全部数字在 **Apple M5 / 16GB / 内置 APFS SSD、macOS、Node v22.22.2、单并发 C=1** 本机采集，按团队纪律只作 **E3 定性结构归因**。它**不是**性能阈值结论、**不**承诺 80–250ms、**不**作为迁 PG 依据；固定 4C8G+SSD 规格机上的 E1 best-of-5 阈值归因仍待外部机器（ADR-0008 §7）。100 万行本轮不跑、不伪造。本文只回答「CPU 烧在哪一类工作、P3 先做哪片」。

---

## 0. 结论（以数据为准，未为推进 Ⅱ 硬凹）

在**生产真实路径**（keyset-on、物理过滤、只 hydrate 当页 100 根、ORM≈268–284/请求，对齐 ADR-0008 §4.1 的 ~214 量级）上，C=1 / 10k 宽表：

- **点引用触发的「整记录重算」（S5b-Ⅱ 的目标三函数 `getMergedCached` / `buildFirstPassMerged` / `computeFormulas`）自身 CPU 占比很小**：三函数 self 合计约占总采样 **0.4%**、占 busy 采样 **1.1–1.2%**；含点引编排（`buildFormulaSource`/`evalOneFormula`）也仅 busy ≈1.4%。
- CPU/wall 的大头是另外两类：① **等 ORM/原生 IO**（idle 占总采样 43–45%，C=1 串行下进程大量时间在等 better-sqlite3/Prisma）；② **展示用 LinkRef 标题物化**（`buildLinkRefs` + `primaryTitle` + 每条 LinkRef 一次 `parseStored`），是 busy CPU 的最大单一来源（self 合计 busy 约 3.3–4.5%，inclusive 约 24–30%，见 §5 口径警告）；prefetch 的 link 行加载（`loadGroup`/`absorb`）、记录拉取（`getRecordsByIds`）与 Prisma 反序列化（`parseEngineResponse`/`toRawRecord`）也显著高于点引重算。

**P3 建议：先做 S5b-Ⅰ（prefetch 边剪枝，治 C-io/oof），置信度中。** 理由：在唯一与生产同构的 keyset-on 100 根路径上，数据不支持「点引整记录重算占 CPU 主导」这一 Ⅱ 的立项前提（三函数 self≈busy 1%），而 link 行/记录的 IO 与物化（idle + loadGroup + getRecordsByIds + 标题物化）才是可见大头，与 Ⅰ 的治理对象同侧。

**但必须向总监显式上报一个计划外发现（影响 Ⅰ 的预期收益口径）**：busy CPU 的最大 JS 来源是 `buildLinkRefs/primaryTitle`——它是**展示列** LinkRef 标题在 `hydrateOne` 第一轮的现解析（`resolveForwardLinks/resolveReverseLinks` 每 links 字段每个 LinkRef 取标题），**既不被 S5b-Ⅰ 的 prefetch 边剪枝消除**（剪的是 prefetch `loadGroups`，计划 §2.1 红线 1 明确展示列 LinkRef 永远现解析、三函数不改），**也不属于 S5b-Ⅱ 的点引子字段投影**。即：本轮数据在 10k/C1 下同时弱化了 Ⅱ 的 CPU 前提，并暴露出一个 Ⅰ/Ⅱ 二分未覆盖的第三类成本（展示标题物化）。是否仍按 Ⅰ→Ⅱ 顺序、或为标题物化另立一片，请总监在 P3 裁决时定夺；本文不自行扩片。

## 1. 采集方法与为什么有两档

- 接入：`scripts/bench/server.ts` 抽纯函数 `buildServerArgs(script, prof?, preload?)`——不传 prof 时 argv 恒为 `["dist/index.js"]`（单测锁定字节一致）；传 prof 时注入 bench 专用预加载 `cpu-prof-exit.mjs`（把 SIGTERM 转 `process.exit(0)`，否则 node `--cpu-prof` 在无信号 handler 的 SIGTERM 下不 flush profile）+ `--cpu-prof/--cpu-prof-dir/--cpu-prof-name`。`run-gate.ts` 加 `--cpu-prof`、`--cpu-prof-dir <dir>` 开关，默认关、零副作用，不碰 `src/index.ts`。
- 解析：`scripts/bench/cpuprof-report.mjs`（零依赖）读 V8 `.cpuprofile`，给每个关注函数的 **self 命中数/ms/占总采样/占 busy 采样**，并附 inclusive（子树）参考与全函数 self top-N。busy 分母剔除 `(idle)/(program)/(root)/(garbage collector)`。
- 两档都跑（这是关键，单看一档会误判）：
  - **keyset-on（生产同构，主证据）**：`--mode on`，read=on/keyset=on/prefetch=on，物理计划 + keyset 只取当页 100 根，ORM≈268–284/请求——这才是 ADR §4.1「~214/请求、点引重算」描述的形态。
  - **legacy off（按派单字面 flag 跑的对照）**：`--mode off`，read=off/keyset=off/prefetch=on。实测该档服务端对**全活表 9493 行**逐条 hydrate 后才在内存分页（ORM≈28147/请求，serveP95≈5.5s），不是 100 根。它把 hydration 工作量放大约 100 倍，适合「放大看计算函数形状」，但**不代表生产请求成本**，故仅作辅助。

## 2. 复跑命令（受管运行时）

```bash
# PATH 前缀受管 node；pnpm 用 /tmp/pnpm9.sh（corepack pnpm9）；cwd=apps/api
export PATH="/Users/daijing/.workbuddy/binaries/node/versions/22.22.2-3/bin:$PATH"

# 1) 干净宽表库（1 万，seed 20260913；9493 活 / 507 软删 / 30 主字段 / 26957 mm links / 84.1MB）
DATABASE_URL=file:/tmp/gx-p2/g10k.db \
  pnpm exec tsx scripts/bench/gen-data.ts --rows 10000 --shape wide --seed 20260913 \
  --manifest /tmp/gx-p2/g10k.manifest.json

# 2) 生产同构 keyset-on（主证据），C=1，warm20/samples200
GX_HYDRATE_PREFETCH=on pnpm exec tsx scripts/bench/run-gate.ts \
  --manifest /tmp/gx-p2/g10k.manifest.json --mode on \
  --scenes home_first --concurrency 1 --warmup 20 --samples 200 --limit 100 \
  --read-p95-ms 0 --max-failure-rate 1 --tag p2-home-on \
  --out-dir artifacts/bench/cpu-prof --cpu-prof
# 对照窄物理场景把 --scenes 换 filter_range_num、--tag p2-range-on

# 3) legacy off 放大对照（全活表 hydrate，非生产形态）
GX_HYDRATE_PREFETCH=on pnpm exec tsx scripts/bench/run-gate.ts \
  --manifest /tmp/gx-p2/g10k.manifest.json --mode off \
  --scenes home_first --concurrency 1 --warmup 15 --samples 50 --limit 100 \
  --read-p95-ms 0 --max-failure-rate 1 --tag p2-home \
  --out-dir artifacts/bench/cpu-prof --cpu-prof

# 4) 解析（self/inclusive/top-N；ms=hitCount×1000us 采样间隔）
node scripts/bench/cpuprof-report.mjs \
  artifacts/bench/cpu-prof/p2-home-on.read.cpuprofile --top 12
```

环境：harness 固定 `GX_BENCH=on`、`GX_RATE_LIMIT=off`、显式 `GX_DATA_DIR`、32 位非内置 JWT_SECRET（见 server.ts）；未设 `GX_HYDRATE_PROJECT/PRUNE`（S5b-Ⅰ/Ⅱ 未实现）。C=1 先排除排队（计划 §7.3）；C≥8 归因留待规格机。

## 3. 三函数（+点引编排）self time 实测

ms 为 200（on）/50（off）个串行请求在被测进程内的累计 CPU self（采样间隔 1ms，故为整毫秒、粒度粗，小值仅作「数量级」证据）。

### 3.1 keyset-on / home_first（100 根，ORM 284/请求，总采样 36525，busy 13082，idle 45.4%）

| 函数 | self ms | 占总 | 占 busy |
|---|---:|---:|---:|
| buildFirstPassMerged | 97 | 0.27% | 0.74% |
| computeFormulas | 24 | 0.07% | 0.18% |
| getMergedCached | 30 | 0.08% | 0.23% |
| **三函数合计** | **151** | **0.41%** | **1.15%** |
| buildFormulaSource | 17 | 0.05% | 0.13% |
| evalOneFormula | 3 | 0.01% | 0.02% |
| buildLinkRefs（展示标题，对照） | 441 | 1.21% | 3.37% |
| primaryTitle（展示标题，对照） | 149 | 0.41% | 1.14% |
| parseStored（每 LinkRef/记录解析，top 热点） | 2721 | 7.45% | — |

### 3.2 keyset-on / filter_range_num（窄物理，100 根，ORM 268/请求，总 36413，busy 15013，idle 43.0%）

| 函数 | self ms | 占总 | 占 busy |
|---|---:|---:|---:|
| buildFirstPassMerged | 92 | 0.25% | 0.61% |
| computeFormulas | 37 | 0.10% | 0.25% |
| getMergedCached | 18 | 0.05% | 0.12% |
| **三函数合计** | **147** | **0.40%** | **0.98%** |
| buildLinkRefs / primaryTitle（对照） | 359 / 131 | 0.99% / 0.36% | 2.39% / 0.87% |
| parseStored | 2778 | 7.63% | — |

两个 on 场景结论一致：过滤形态（首页无过滤 vs 窄 range）几乎不改变点引三函数的微小占比；home 与 range 的 ORM、self 分布同形。

### 3.3 legacy off / home_first（全 9493 活行 hydrate，ORM 28147/请求，总 187529，busy 32539，idle 78.2%）

| 函数 | self ms | 占总 | 占 busy |
|---|---:|---:|---:|
| buildFirstPassMerged | 1828 | 0.97% | 5.62% |
| getMergedCached | 578 | 0.31% | 1.78% |
| computeFormulas | 586 | 0.31% | 1.80% |
| 三函数合计 | 2992 | 1.60% | 9.20% |
| buildLinkRefs / primaryTitle（对照） | 699 / 223 | — | 2.15% / 0.69% |
| parseStored | 5857 | 3.12% | — |

即使把工作量放大约 100 倍（全表 hydrate），三函数 self 也只占 busy 9.2%；idle 升至 78%，说明放大后更是 **IO 等待主导**（28k 次 ORM 往返），而非 JS 重算主导。这与 ADR §4「端到端成本主要在 hydration 的 ORM 扇出」一致，但把 §4.1「点引整记录重算是 CPU 主成本」的早期 E3 猜测，在本机 keyset-on 路径上**证伪为非主导**。

## 4. 全函数 self top（keyset-on/home，定位真实热点）

`(idle)` 45.4% · `(program)` 16.1% · `parseStored` 7.45% · Prisma `parseEngineResponse` 5.56% · `getRecordsByIds`（BatchStore/点引回源）4.56% · **`loadGroup`（prefetch link 行整查）4.12%** · GC 2.78% · Prisma `toRawRecord` 1.88% · **`absorb`（link 行摊桶）1.41%** · buildLinkRefs 1.21%。

读法：剔掉 idle/program/GC 后，busy JS 集中在 (a) 反复 JSON.parse 记录字段（parseStored）、(b) Prisma 引擎结果反序列化（parseEngineResponse/toRawRecord）、(c) prefetch link 行加载与摊桶（loadGroup/absorb，S5b-Ⅰ 直接治理对象）、(d) 记录 IN 拉取（getRecordsByIds）、(e) LinkRef 标题物化。点引三函数不在前 10。

## 5. 口径与可信度警告（防误读）

1. **inclusive 在 async/await 代码上失真**：V8 profile 的调用帧在 await 续体处不连续，出现「后代 `buildLinkRefs` inclusive(3866ms) > 祖先 `buildFirstPassMerged` inclusive(249ms)」的不可能关系。故**结论以 self（可加、稳健）为准**；报告脚本仍输出 inclusive 仅作热点存在性参考，不做跨函数相加。
2. 1ms 采样粒度：三函数 on 档 self 仅十几–几十毫秒（十几–几十次命中/200 请求），数量级判读为「很小」可靠，但具体个位 ms 不精确。
3. C=1 串行：idle 占比高是「单请求等 IO」的真实形状；并发下 idle 会被其他请求填满、墙钟结构变化。**C≥8 的 CPU 结构必须在规格机重采**，本文不据 C=1 idle 推断并发吞吐。
4. 规模仅 10k；ADR §4.2 的 ownerLink mega-hub 扇出在 100k/500k 才到 7k/23k 行，Ⅰ 的 link-IO 收益随规模上升的假设需规格机大库验证。

## 6. 对 S5b 计划的输入（不越权改计划/ADR）

- P3 数据裁决：**建议先 Ⅰ**（C-io/oof：loadGroup/absorb/getRecordsByIds/idle-IO 同侧），置信度中；Ⅱ 赖以立项的「点引整记录重算 CPU 主导」在本机 keyset-on 100 根路径上未获数据支持（self≈busy 1%）。
- 新增裁决项（请总监定）：展示用 LinkRef 标题物化（buildLinkRefs/primaryTitle/parseStored）是 busy 最大 JS 来源，但按计划 §2.1 红线 1，Ⅰ 不改这三个函数、展示列永远现解析；它也不在 Ⅱ 的点引子字段投影范围。是否接受「Ⅰ 先做、标题物化记为已知第三类、后续单独立项」，还是调整 P3，请裁决。
- 本结论在规格机 E1 best-of-5（4C8G+SSD、含 C≥8 与 100k/1m）出来前仅作本机方向输入；若规格机数据反转（点引重算在大库/高并发下变主导），以规格机为准。

## 7. 产物（E3，gitignored，不入库）

`apps/api/artifacts/bench/cpu-prof/`：
- `p2-home-on.read.cpuprofile`（544KB）/ `p2-range-on.read.cpuprofile`（551KB）：keyset-on 主证据；
- `p2-home.read.cpuprofile`（2.0MB）/ `p2-range.read.cpuprofile`（2.2MB）：legacy off 放大对照；
- 同名 `.report.txt`：解析器完整输出（self/inclusive/top-12）；`home.log/range.log/home-on.log/range-on.log`：run-gate 原始行（含 ORM 均值）。

入库代码（独立 commit）：`scripts/bench/server.ts`、`scripts/bench/run-gate.ts`（透传开关）、`scripts/bench/cpu-prof-exit.mjs`（SIGTERM flush 预加载）、`scripts/bench/cpuprof-report.mjs`（零依赖解析）、`scripts/bench/__tests__/server-args.test.ts`（off argv 字节一致 + on 透传形状，4 测试）。`src/domain/hydrate.ts`、`hydrateBatch.ts` 零字节改动；无任何 GX_HYDRATE_PRUNE/PROJECT 生产代码。
