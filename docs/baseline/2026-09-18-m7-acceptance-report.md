# GouXiangDB 企业版 M7 总验收报告（进行中 · 逐门如实登记）

- 候选提交：`ae65f23`（main，线性）；迁移数：**23**（门②实测 `applied=23 / rolled_back=0`）
- 验收窗口：2026-09-17 ~ 进行中；执行人：后端/前端 worker + 项目总监独立复验
- 报告状态：**门②已过闸；门①/④台账成稿并补测关闭；门③脚本开发中；门⑤/⑥/⑦/⑧未执行**
- 数字纪律：本机数字一律标"内部留档（开发机）"，**不写进对外承诺**；Tier-L 真机数字才可用于承诺
- 测试实数口径：全量门须由总监独占机跑（G0），本报告只登记**已实跑的定向实数**，全量数待回填

## 1. 五主线对抗（门①）

权威台账：`docs/baseline/2026-09-18-m7-gate-ledger.md`（commit `f5fb7bc`）

| 项 | 状态 | 证据 |
|---|---|---|
| 47 条对外 AC 归属 | ✅ 全部有真实会执行的自动化，零"找不到文件" | 台账 A 节（39 条全自动闭环，8 条自动+签字） |
| 定向实跑 | ✅ 193 文件 **2028 passed**，0 fail | api 159 文件 1597 + e2e 6 文件 64 + web 23 文件 278 + shared-types 56 + canvas 33 |
| M4 规模门 | ✅ `GX_M4_GATE=1` 真跑 10/10 | scope/decide 12000 次零分叉 + P95 上界断言 |
| 缺口处置 | ✅ 9 项全裁决 | C-1/C-2/C-5 由 `528ecee`/`55f5213` 补码关闭；C-3/C-4/C-6/C-7/C-8/C-9 按手测/runbook/产品限制/真机限定值登记（台账 C.0 节） |

**待补**：G0 全量门独占跑（本机 swap 压力大，与门③演练不并发）。

## 2. AC-UPG-1 直升零损坏（门②）— **已过闸**

- 路径：tag `v0.1.0`（`637eb9d`，11 迁移）→ HEAD（23 迁移），一条直线 `prisma migrate deploy`
- 独立重跑：总监全新 RUN_DIR `/tmp/gx-upgrade-drill-lead4`（dist 真空重建），**19 步全 0、DRILL_VERDICT=PASS**
- **总监独立重算零损坏**（不采信脚本自判）：15 组实体 idSet/count 零失配；500 records 逐行 fields JSON **0 diff** + 三时间戳列 **0 改动**；26 kb_docs content **逐字节 0 diff**、contentVersion 0 递增；damageCount=0
- 其余：B5 自举 23/0、owner 唯一、auth_policies reason 18/8/9；黄金 12/12 + LCG 24/24；分享 13/13；search FTS-only chunks=5528 coverage 全 0 零外网 + 删库自愈；body 七边界全过
- 过程中抓两个环境/脚本假象并固化：①受管 node 的 `fs.rmSync` 安全删除 shim 超时致构建假 FAIL → 构建失败即 die（`85da169`）；②阶段8/9 原直接写证据主库 → 改静止库 scratch 副本 + wal_checkpoint（`0ff23a1`）
- 根因层修复：`5f2455b`（TCP 优雅关闭补 `prisma.$disconnect`，实测 SIGTERM 0s 退出且 wal/shm 释放）——总监实测追认

## 3. 回滚演练（门③）— **未过闸，脚本开发中**

- `scripts/acceptance/run-rollback-drill.sh` **尚未产出**；已重派（R1~R7 行为层真 dist 服务实演计时，R8/R9 出手测模板）
- 待其回报后由总监独立重跑裁决，判据 R1~R8 ≤30 分钟且旧行为断言全过

## 4. 用例台账（门④）

- RC-01~40：20 条有自动化（18 全自动 + RC-02/26 半自动），20 条为 RC 文档自标【UI】/【手册】手测
- RC-41~55（G/H 组）：15 条全自动化
- 本轮新增补测实跑坐绿：menu-write **12**（C-2 权威 parentId 直断 + 真 `GET /api/tables/:id` 200）、s8-members-perf **4**（门控 p95<150ms，实测 2.22/0.67/0.44ms；默认 skip）、sanitize-html **36**（RC-26 URL 白名单，含控制字符混淆 `javascript:` 拦截）
- 遗留手测签字项：台账 D 节 10 条（画布 RC-13~25、RC-03/05/06/36/39/40、RC-27、M6-3a/3b 浏览器目检、Playwright canvas-mcp-golden）

## 5. 性能（门⑤）— **已汇总，判为「有条件过」**

权威登记：`docs/baseline/2026-09-18-m7-gate5-performance.md`（证据 **22 条** / 缺口 **10 条**，每条标机器规格、测法样本量、阈值结论）

### 5.1 三档机器口径

- **【M-A】Tier-L 真机**（x86_64 / 2 vCPU Xeon E3-1220 v6 / MemTotal 5926MiB / ext4 rotational=1 / Node v22.22.1）：**唯一可对外引用**
- **【M-B】开发机**（macOS arm64 Apple M5 / 16GB / APFS）：一律"内部留档（开发机）"，**不进对外材料**
- **【M-C】未做**：不得出现任何数字

### 5.2 已实测并过阈值的门时必填项（均为【M-B】内部留档）

| 项 | 实测 | 阈值 | 结论 |
|---|---|---|---|
| 通讯录 500 成员三接口（`528ecee` 门控） | warmP95 **2.22 / 0.67 / 0.44 ms**；S8/S9 三轮最差 5 页 p95 11.51ms | p95<150ms | 过 |
| M4 规模门（500 用户 / 万节点 / 3000 策略） | decide P95 **0.36–0.41ms**（n=252）、scope P95 **41.8–44.0ms**（n=21）；SQL 非 owner 4 条 / owner 3 条、EXPLAIN 全走索引无裸 SCAN、12000 次零分叉 | p95<500ms | 过 |
| 组织求值定数 SQL | `effectiveRoleRows` ≤3、`listMembers` 恒 4（10 人 = 500 人） | 无 N+1 | 过 |
| MCP 超时机制 | 慢夹具 5000ms + `GX_MCP_TOOL_TIMEOUT_MS=1200` → **1284ms 返 TIMEOUT**，同 socket ping 正常 | 不挂连接 | 过（默认 30000ms 档未端到端实证） |
| MCP 限流可观测 | 桶调 3 → 前 3 放行、**第 4 次 429** + `Retry-After: 60` | 可观测 | 过（生产档 IP 300/60s、patId 120/60s） |
| M1 物理索引层 / T0 连接层 | 50 万行 0.386–12.153ms 无裸 SCAN；5k/C=8/19 场景 3601 采样 failures=0、T0 三条件全过 | ADR-0008 不触发 | 过（**7 条 T3 场景 P95 仍 breach，归 #89/S5b 后**） |
| M5 召回侧 SQL 常量化 + 三路 EXPLAIN | 召回 SQL 恒 1 条、非 INSERT 恒 5 条；三路均有 `temp_scope` 覆盖索引 | 与节点/主体数解耦 | 过（小规模下界） |

### 5.3 未过 / 未做（不补编、不插值）

- **检索门未过**（【M-A】Tier-L x86_64，rounds=10）：hybrid p95 1k≈20.6ms / **10k≈646ms / 100k≈14,571ms**（门 500ms）；fts-only 10k≈151.9ms 达标、100k≈3,670ms。瓶颈＝vec0 无 ANN 暴力全扫 ∝N；收紧 scope 与调 k 实测**无效**，唯一有效杠杆是控 chunk 总量；RSS 105→187MiB 有界。外推 hybrid 流畅上限 ≈6.5k chunk
- **Tier-L arm64 真机未做**（仅 CI 交叉构建冒烟）→ 对外不得出现 arm 性能数字
- **C-7 / SPEC:134「10 万节点首屏 <1s」未做**：`2026-09-16-m3-gate.md` 不存在，`reconcile-scale` 仅 1k/1w 且无时延断言，task#158 pending → 按**限定值**登记，阻断"10 万节点"承诺口径
- **M1 100 万行终验未做**（待固定 4C8G+SSD）；**M1 读路径 shadow 等价证据未做**（#103/#106/#110 在途）
- **M5 主写 P95** 仅 `toBeLessThan(150)` 断言绿（n=30），实测毫秒数未留档 → 只写"过 150ms"，不引用具体值
- 另需并读 §8 P1：`SearchIndexer` 从未接电，故"索引不饿死主写"目前是**无索引进程运行**下的状态，不构成 worker 运行下的证据

### 5.4 门⑤结论与发布姿态

**有条件过**（走计划 §10.2 已预批的 B-5 降级路径，不阻塞 M7）：

1. 默认发布：`GX_EMBEDDING_MODE=off` + FTS trigram；语义/向量为管理员显式配置 + 二次确认启用，`GX_M5_SEARCH` 默认 off
2. cloud 作**高配能力**交付；**对外材料禁写 cloud / hybrid / vector 性能承诺**
3. 唯一可对外数字＝【M-A】参考画像（关键词路 10k≈0.15s / 100k≈3.7s；hybrid 舒适区 ≤2–3k chunk），引用须带机器规格与"非硬承诺"口径
4. 其余全部数字为开发机内部留档，只进内部台账
5. 完整过闸还欠门⑧四项签字中的「Tier-L 措辞」与「M1 读路径姿态」（后者前置证据未做）

## 6. 部署物与三环境冒烟（门⑥）— **未执行**

- 待办：裸机 / 飞牛 fpk / Docker / macOS 四形态冒烟矩阵；SDK/vec0/stdio bin 核查；checksums
- 本机可用 colima（Docker）做 Linux 面；飞牛/arm 双架构为外部依赖

## 7. 默认姿态确认（§4.1）+ 四项签字 — **未完成**

- 待门③ R1~R7 实演后逐旗确认实际 env 与旧行为
- 四项总监签字：authz 姿态、embedding 姿态、Tier-L 措辞、M1 读路径姿态 —— 均未签

## 8. 缺陷清单

| 类 | 项 | 状态 |
|---|---|---|
| 已修（本轮） | `5f2455b` TCP 优雅关闭不释放热 WAL（门② CORRUPT 根因） | 总监实测追认，已合入 |
| 已修（本轮） | `e6d493e` sanitize-html data 特判不可达死代码 + 注释谎称 | 等价删除，36 例锁回 |
| 已修（本轮） | `ae65f23` ci-quality 受 shim 劫持假红 | 已合入 |
| 挂账 | C-7 十万节点首屏门（task#158） | backlog，M7 后 |
| 挂账（P2） | 富文本内联 `data:` 图片被 URL 白名单过拦（fail-closed 安全方向正确，功能限制） | 待产品决策，登记 RELEASE 限制 |
| 待观察 | api 全量门在本机 swap 压力下收尾慢/易 flaky | 全量门归 VM/空闲机，需 VM 凭证 |
| **P1 挂账（本轮发现·实证）** | **M5 增量索引链路未接线**：`GX_SEARCH_WORKER` 全仓零命中；`SearchIndexer` 从未被 new/start（`src`/`scripts` 下无调用点，仅测试用）；`change_events` **无任何清理/截断**；`reindex.ts` 不碰 outbox。实证：门② `/tmp/gx-upgrade-drill-20260918-065029/after/search-result.json` 全量 reindex 完成（chunks=5528、coverage 全 0）后 **pending=520 不降** | 后果：① outbox 只增不减→长期运行表无限增长；② 增量同步从不发生，搜索数据只能靠手动 `/api/v1/admin/reindex` 全量刷新。**已实现能力（SearchIndexer.runOnce/processOne）是孤儿，未接电**。计划 §4.1 矩阵声称的 `GX_SEARCH_WORKER=on` 与实现不符。建议：M7 按已知限制发布 + 立即排 hotfix 接线（接通既有能力，非新功能）；是否纳入 M7 范围待总监/主理人裁决 |

## 9. 结论

**尚未通过** —— 门②过闸、门①/④台账成稿且缺口已裁决关闭，但门③/⑤/⑥/⑦ 未执行，门⑧四项签字未签。
判据（§10.2）中第 3/5/7 条不满足，故当前只能登记为"进行中"，不构成放行。
剩余阻塞：**门③脚本与独立重跑**、**全量门独占跑**（需空闲机或 VM `192.168.31.15` 凭证）、**三环境冒烟**（飞牛/arm 为外部依赖）。
