# M1/S10 收口证据：#84 闭环复跑（干净 5k / C8 / 全量 19 场景含多数值字段 AND）

- 留证日期：2026-09-13
- 留证人：后端工程师 贝洛奇
- 上位文档：`docs/adr/0008-sqlite-capacity-falsification-gate.md`（§5 T0、§5.3 三条件）、`docs/baseline/2026-09-13-m1-s10-t0-unlock.md`
- 代码基线：`e656abb`（compileCount 多 JOIN 钉 `INDEXED BY "rfi_record_field_ord_key"`，任务 #94/#90）；本次留证时 HEAD 为 `b119697`（ADR-0008 §3 文档修订，无代码/门工具变更）
- 产物（E2，gitignored）：`apps/api/artifacts/bench/t0-rerun-on-c8-full.{json,md,read.server.log,write.server.log}`
- 机型（非固定规格压测机，数字按"本机参考"标注）：Apple M5 / 16GB / 内置 APFS SSD；受管 Node v22.22.2、pnpm 9.0.0、better-sqlite3 13.0.3（SQLite 3.53.4）、Prisma 5.22.0、esbuild 生产产物 389 KiB

> 结论（team-lead 已独立核验并裁定 #84 闭环）：在**全新生成的干净 5k 库**上，按 ADR §5 原参数（C=8 / warmup 50 / samples 200 / limit 100，flags read/keyset/prefetch 全 on）跑**全量默认场景矩阵（19 场景，未用 --scenes 裁剪）**，3,601 采样 failures=0、timeouts=0、每场景 `errors={}`；新增的多数值字段宽命中 AND 场景 `filter_range_multi_num`（修复前 100k 实测双字段 22.8s、三字段 O(n³) 跑不完的查询类）200 采样 0 失败、serve P95=1374.61ms。audit-server-log.mjs 对读/写两日志均判 t0Pass=true、零尾挂、零 5xx。run-gate 退出码 2 仅来自 7 条 T3/宽口径场景 P95≥1500ms（应用层内存排序/残余/分桶/有界搜索成本），与 T0 连接层为两套判据，归属 #89 / S5b 后的已知应用层成本项，不记 #84、不动"物理索引层 pass / 不迁 PG"结论。本文只登记实测数字，不预判 S5b 结论，不改 ADR。

---

## 1. 复跑参数与干净库

- 库：不复用历史写污染库，重新确定性生成。`gen-data.ts --rows 5000 --shape wide --seed 20260913` → 4,725 活记录 / 275 软删 / 13,351 linksMm / 1,906 linksHm / 107,347 sidecar 行 / 41.96 MB。
- 门命令（全量矩阵；未传 `--scenes`）：
  ```
  tsx scripts/bench/run-gate.ts --manifest /tmp/gx-t0-rerun/g5k.manifest.json \
    --mode on --concurrency 8 --warmup 50 --samples 200 --limit 100 \
    --read-p95-ms 1500 --max-failure-rate 0.01 \
    --tag t0-rerun-on-c8-full --out-dir /tmp/gx-t0-rerun/out --skip-build
  ```
- 耗时 34m47s。flags：read=on、keyset=on、prefetch=on。超时门 30000ms。
- 19 场景构成：home 3（home_first/home_deep/deep_window_edge）+ view/search 14 + write 1 + mixed 1；新增 `filter_range_multi_num` 在 `scenarios.ts` 默认矩阵（非白名单），宽表必生成、窄表不生成。

## 2. T0 三条件（ADR §5.3）：全部满足

`node scripts/bench/audit-server-log.mjs` 对两个服务端日志分别 exit 0：

| 日志 | 业务流 | 进入 `<--` | 响应 `-->` | 尾挂 | 状态码分布 |
|---|---|---|---|---|---|
| read.server.log | home | 501 | 501 | 0 | 200×500，400×1 |
| read.server.log | view-search | 3,500 | 3,500 | 0 | 200×3,500 |
| write.server.log | home | 120 | 120 | 0 | 200×120 |
| write.server.log | write（POST /api/records） | 350 | 350 | 0 | 201×350 |

逐条：

1. **服务端收包数 == 客户端成功发送数**：四流 FIFO in==out、尾挂全 0；JSON 报告 19 场景 failures=0、timeouts=0、errors 全为 `{}`。
2. **status=0（连接失败）归零**：无任何传输层错误码入直方图，连接失败率 0；服务端无 5xx。
3. **C=8 连接失败率 = 0**：达成。

唯一非 2xx：read.server.log L1007 `GET /api/records?tableId=…&limit=100&offset=600 → 400 2ms`，是 `deep_window_edge` 场景（n=1）对 keyset-on 超窗 offset=600 的**预期断言响应**（该场景 failures=0），非异常。

写后离线对拍：`sidecarDrift={drift:0, missing:0, extra:0, mismatch:0, orphans:0}`；`shadowDrift.count=0`。

## 3. 全量 19 场景逐项（n / failures / timeouts / serve P95 / errors）

errors 列全场景为 `{}`（无任何分桶可画），故不单列。

| 场景 | 档 | n | 失败 | 超时 | serve P95 (ms) |
|---|---|---|---|---|---|
| home_first | T1 | 200 | 0 | 0 | 1452.77 |
| home_deep | T1 | 200 | 0 | 0 | 791.70 |
| deep_window_edge | 边界(预期400) | 1 | 0 | 0 | 1.43 |
| filter_eq_select | T1 | 200 | 0 | 0 | 892.54 |
| filter_range_num | T1 | 200 | 0 | 0 | 1293.40 |
| **filter_range_multi_num** | T1（多 rfi JOIN） | 200 | **0** | **0** | **1374.61** |
| filter_isanyof | T1 | 200 | 0 | 0 | 1371.96 |
| filter_or_physical | T1 | 200 | 0 | 0 | 1219.99 |
| sort_number_desc | 回退路径 | 200 | 0 | 0 | 9296.66 |
| sort_clean_number_desc | T2 | 200 | 0 | 0 | 1178.44 |
| sort_date_asc | T2 | 200 | 0 | 0 | 1264.13 |
| sort_select_text | T3 | 200 | 0 | 0 | 9364.99 |
| filter_and_or_residual | T3 | 200 | 0 | 0 | 8412.23 |
| aggregations | 物理聚合(分页前全量) | 200 | 0 | 0 | 1854.03 |
| group_by_select | T3 | 200 | 0 | 0 | 8635.62 |
| search_short | T3 | 200 | 0 | 0 | 8956.60 |
| search_word3 | T3 | 200 | 0 | 0 | 9169.23 |
| write_create | 写 | 200 | 0 | 0 | 242.60 |
| mixed_home_write | 混合 | 200 | 0 | 0 | 1270.54 |

合计 3,601 采样，0 失败、0 超时。所有 T1 物理命中与 T2 物理排序场景（含 multi_num）serve P95 均 <1500ms；写 242.60ms、读写混合 1270.54ms。

## 4. 点名场景：filter_range_multi_num

- 定义（`scripts/bench/scenarios.ts`，默认矩阵）：`money gte 500 AND money lte 95000 AND rate gte 2 AND rate lte 98`，金额+比率两个数值字段宽范围、高命中 AND，生成两个 `record_field_index` JOIN。
- 意义：这是任务 #94/#90 修复针对的查询类——修复前 SQLite 以 `rfi_table_field_num` 为外层驱动嵌套回表（team-lead 100k 实测：双字段 count 22.8s/取页 22.9s、三字段 52s/55s 量级的 O(n²)/O(n³)）；`e656abb` 在 JOIN 内表钉 `INDEXED BY "rfi_record_field_ord_key"` 后计划稳定为 records 覆盖索引外层线性扫 + 每 JOIN 按 recordId seek。
- 本轮实测（5k / C8）：n=200，失败 0、超时 0，QPS=8.84，serve P50=804.78 / **P95=1374.61** / P99=1394.35 / max=1397.60ms；physicalSqlAvg=3（证明确实走多 rfi JOIN 物理计划，未回退内存路径、非恒真过滤）；prismaCallsAvg=203.1（与其它 T1 场景同量级，无整表 hydrate 扇出）。
- 回归防护：该路径的形态与正确性由 `compileCount.test.ts`（每 JOIN 含 INDEXED BY 的纯形态断言）与 `countJoinMultiNum.test.ts`（N=400 偏态高命中真库夹具：EXPLAIN 必须 covering index 驱动 records、每个 rfi 走 ord_key、禁止 rfi_table_field_num 当驱动；COUNT 与首页/深页 id 序列对拍内存 evalFilter 全等）锁定，断言不含毫秒阈值。

## 5. GATE_EXIT=2 的 7 条 breach 清单与归属（非 #84）

run-gate 判 FAIL 的唯一依据是读 P95 门（1500ms），7 条全部 failures=0/timeouts=0，且场景描述自标非证伪门对象：

| breach 场景 | serve P95 (ms) | 应用层成因（实测 prisma 均/请求） | 归属 |
|---|---|---|---|
| sort_number_desc | 9296.66 | money 含 0.5% 脏值触发 sortNumericClean 回退，整表 hydrate 内存排序（14,322） | #89 / S5b 后已知项 |
| sort_select_text | 9364.99 | valueText 因 BINARY/zh-CN  collation 差异保守内存排序（14,035） | #89 / S5b 后已知项 |
| filter_and_or_residual | 8412.23 | OR 含 longText 残余谓词，分页前全量物化（14,031） | #89 / S5b 后已知项 |
| aggregations | 1854.03 | 分页前全量物理聚合（物理 SQL 6 条、prisma 201；仅略超门） | S5b 后已知项（非连接/非回归） |
| group_by_select | 8635.62 | groups 分页前全量分桶 + 桶聚合（14,036） | #89 / S5b 后已知项 |
| search_short | 8956.60 | 单字宽命中，2000 行/表有界预览内内存搜索（ADR-0005 已登记） | #89 / S5b 后已知项 |
| search_word3 | 9169.23 | 三字命中 longText 备注，同上有界内存搜索（14,035） | #89 / S5b 后已知项 |

共性：prisma 往返约 14,030–14,320 次/请求，是 hydration ORM 扇出 + 应用层内存计算成本，随端到端口径增长；物理 SQL 条数仍为常量（2–6 条）。这些条目的端到端亚秒收口以前置条件为准：S5b-Ⅰ/Ⅱ 实施计划经 team-lead 终审后实施、`node --cpu-prof` 归因、固定 4C8G+SSD 规格机 best-of-5（与 ADR §6 一致）。本文不对 S5b 效果做预判。

## 6. S10 客观状态（登记，不替总监置 ADR 状态）

- 物理索引层：pass（ADR §3 选择性三形态，50 万物理命中亚毫秒~毫秒级，无 SCAN；多字段 AND 经 #94 修复后同层）。
- harness / T0 连接层可信度：已解锁，并经带多字段场景的全量 19 场景 C8 复测（本文）。
- 端到端 T3 亚秒与 100 万终验：仍 INCONCLUSIVE，前置=①S5b-Ⅰ/Ⅱ 计划终审后实施 ②node --cpu-prof 归因 ③固定 4C8G+SSD 规格机 best-of-5。

## 7. 复现命令

```bash
# 干净库
DATABASE_URL=file:/tmp/gx-t0-rerun/g5k.db \
  pnpm --filter @gx/api exec tsx scripts/bench/gen-data.ts \
  --rows 5000 --shape wide --seed 20260913 \
  --manifest /tmp/gx-t0-rerun/g5k.manifest.json

# 全量矩阵 on 档门（不传 --scenes）
pnpm --filter @gx/api exec tsx scripts/bench/run-gate.ts \
  --manifest /tmp/gx-t0-rerun/g5k.manifest.json --mode on --concurrency 8 \
  --warmup 50 --samples 200 --limit 100 --read-p95-ms 1500 --max-failure-rate 0.01 \
  --tag t0-rerun-on-c8-full --out-dir apps/api/artifacts/bench --skip-build

# T0 服务端 FIFO 对账（两个日志分别跑，exit 0 = t0Pass）
node apps/api/scripts/bench/audit-server-log.mjs \
  apps/api/artifacts/bench/t0-rerun-on-c8-full.read.server.log
node apps/api/scripts/bench/audit-server-log.mjs \
  apps/api/artifacts/bench/t0-rerun-on-c8-full.write.server.log
```
