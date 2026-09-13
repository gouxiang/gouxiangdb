# M1 数据底座运维：sidecar 重建、大表提示、功能 flag 回退、搜索边界

M1（数据底座）在 SQLite 主表之外引入了派生旁路索引 `record_field_index`（ADR-0004）、
写串行队列、keyset 分页等能力，均带环境变量 flag，可一键回退到旧行为。本手册覆盖
日常巡检、重建、紧急回退与已知边界。架构背景见 [ADR-0004](../adr/0004-eav-sidecar-index.md)、
[ADR-0005](../adr/0005-fulltext-search.md)；压测结论见
[`../baseline/2026-09-13-m1-s10-gate.md`](../baseline/2026-09-13-m1-s10-gate.md)。

> 命令默认在 api 应用目录（发布物解压后的 `apps/api` 或等价 current 目录）执行；
> 生产 `DATABASE_URL` 由 `/etc/gouxiangdb/env.conf` 注入，跑脚本时带上同一值。
> 巡检/重建脚本用 `tsx` 运行（devDependency）；生产精简安装若不含 tsx，
> 在同版本源码/发布工作目录（含 devDependencies）执行，只连同一个库文件即可。

## 1. sidecar 巡检（只读，drift=0 才退出 0）

```bash
DATABASE_URL=file:/var/lib/gouxiangdb/app.db \
  pnpm tsx scripts/bench/check-sidecar.ts --batch 1000
# 只查一张表：追加 --table <tableId>；抽样异常行上限：--sample-limit 20
```

输出逐表的缺失/多余/值不一致/孤儿行数。该命令只读库，可在线运行，建议在
发版后或怀疑写维护异常时跑一次。退出码非 0 即存在 drift，按第 2 节重建。

## 2. sidecar 重建（可重跑、低峰执行）

sidecar 是 `records.fields` JSON 的纯派生数据，任何时候都可截断重建，不动真相表：

```bash
# 逐表 id 游标分批、批内先删后插；不开跨全表大事务（避免大表锁库），中断重跑仍收敛
DATABASE_URL=file:/var/lib/gouxiangdb/app.db \
  pnpm tsx scripts/bench/backfill-sidecar.ts --batch 1000
# 单表：--table <tableId>
```

- 重建期间服务可继续运行：写维护（开着时）与回填都以"先删后插 + 唯一键"幂等；
  保守起见在业务低峰执行，重建后务必再跑一次第 1 节巡检确认 drift=0。
- 应用 `table.clear` / 表复制已在应用层同事务维护 sidecar，无需手工介入。

## 3. 功能 flag 与紧急回退（M1 内不删旧路径）

| flag | 默认 | 取值 | 作用 |
|---|---|---|---|
| `GX_M1_WRITE_QUEUE` | 生产 on（test off） | on / off | 进程内写串行队列；off 回退直接执行事务 |
| `GX_M1_SIDECAR` | on | 任意 / **off** | sidecar 同事务写维护；off 停写（表闲置无害） |
| `GX_M1_SIDECAR_READ` | **off** | off / shadow / on | 读下推；shadow 只对拍记日志不改响应，on 才走查询计划器 |
| `GX_M1_KEYSET` | **off** | off / shadow / on | keyset 游标分页；仅在 `SIDECAR_READ=on` 时才对外生效 |
| `GX_HYDRATE_PREFETCH_DEPTH` | 3 | 整数 ≥0 | hydration 预取关联跳数（仅调参/压测） |
| `GX_HYDRATE_PREFETCH_BUDGET` | 夹[400,2000]，16/根 | 整数 ≥0 | 单请求预取记录总量内存闸 |
| `GX_BENCH` | off | on | 仅压测：响应头埋点，生产保持关闭零开销 |

**一键回退到 M0 读/分页行为**：在 `/etc/gouxiangdb/env.conf` 设

```bash
GX_M1_SIDECAR_READ=off
GX_M1_KEYSET=off
```

重启服务（`sudo systemctl restart gouxiangdb-api`）。写侧 `GX_M1_SIDECAR` 一般保留 on
（停写只在排查 sidecar 本身时用，停写后重新开启需按第 2 节回填追平）。
`GX_M1_WRITE_QUEUE=off` 仅在定位到队列自身问题时使用，正常生产不要关。
改 flag 后用 `curl -fsS http://127.0.0.1:3001/readyz` 确认就绪。

灰度纪律：任何新读路径先在 `shadow` 连续观察一个迭代、对拍 0 差异，才允许切 `on`；
旧路径与 flag 在 M1 内保留（保证可回退），稳定一迭代后另开清理任务删除，不在 M1 内删。

## 4. 大表提示（容量边界，来自 S10 实测）

- 物理索引层健康：50 万行带索引过滤命中 0.4–12ms、无全表 SCAN（见 S10 报告 §2）。
- 端到端列表的剩余瓶颈在应用 hydration 的**关联字段扇出**：宽表上大量/无界的
  links/subtable 关系会让单请求取数量随整图膨胀。M1 已加预取深度(3)+总量预算闸
  （默认夹 400–2000 条/请求）兜底内存安全；计算字段（lookup/rollup/count/formula）
  的排序/筛选在大表已由前端置灰（S8）。
- 运维建议：单表接近 10 万行且含密集关联时，关注服务 RSS 与列表 P95；
  出现明显变慢先查是否存在"一条记录挂成千上万关联"的超级 hub（偏态关系）。
  关联扇出的进一步收口（按被引用关系剪枝、聚合下推 SQL）是 M1 之后的专项，
  不属于 SQLite 物理索引问题，也不触发迁库（ADR-0008 本轮判定不触发）。
- 100 万行端到档终验待固定规格 4C8G+SSD 压测机；本机数字仅作参考。

## 5. 已知限制：全局搜索是「有界预览」

`/api/records/search` 与 `/api/search` 的记录支路，对每张表**最多取 2000 条活记录**
做内存子串匹配（常量 `SEARCH_PREVIEW_LIMIT`，ADR-0005）：

- 单表活记录超过 2000 行时，更早的记录**不会**被搜到——这是显式登记的已知边界，
  不是故障；搜索响应带 `boundedPreview:true` 与 `previewLimit:2000` 标记，前端据此提示。
- M1 不扩成全表扫描、也不在主库建 FTS 虚表。统一全文检索（独立可重建检索派生库；
  trigram 对 2 字中文词不命中、需短词 LIKE 回退，已实测）在 M5 落地后替换本口径。

## 6. 排障速查

| 现象 | 先看 | 处置 |
|---|---|---|
| 列表结果疑似不对 | `GX_M1_SIDECAR_READ` 是否 on | 先置 shadow 对拍看日志差异；必要时回 off |
| 怀疑索引与 JSON 不一致 | 第 1 节巡检 | drift≠0 → 低峰 backfill 重建 → 再巡检 |
| 大表列表慢/RSS 高 | 第 4 节，查超级 hub | 计算字段排序筛选置灰；评估调预取预算；等扇出收口 |
| 写出现 SQLITE_BUSY | `journal_mode/busy_timeout`（应 wal/5000） | 见 [wal-crash-recovery.md](wal-crash-recovery.md)；确认写队列 on |
| 搜索漏记录 | 是否超 2000 行/表 | 属有界预览（第 5 节），M5 统一检索解决 |
