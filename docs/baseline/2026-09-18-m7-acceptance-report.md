# GouXiangDB 企业版 M7 总验收报告（进行中 · 逐门如实登记）

- 候选提交：`ae65f23`（main，线性）；迁移数：**23**（门②实测 `applied=23 / rolled_back=0`）
- 验收窗口：2026-09-17 ~ 进行中；执行人：后端/前端 worker + 项目总监独立复验
- 报告状态：**门①②③④已过闸（③为总监独立重跑坐实）；门⑤/⑥/⑦/⑧未执行**
- 数字纪律：本机数字一律标"内部留档（开发机）"，**不写进对外承诺**；Tier-L 真机数字才可用于承诺
- 测试实数口径：全量门由总监在 VM `192.168.31.15`（2C/5.9G，免密）独占跑；已得一轮：**Test Files 1 failed（该失败为 nav-sync-tables 的 beforeAll hook 超时，已由 `11c4dc8` 给 30s 预算，待复跑）/ 194 passed / 3 skipped；Tests 2127 passed / 28 skipped（2155）**，耗时 1188.60s；该轮早于 P1 修复 `249df44`，故需重跑

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

## 3. 回滚演练（门③）— **已过闸（总监独立重跑坐实）**

- 交付：`7a80e18`（R1~R7 行为层真 dist 服务实演计时、R8 静态读码、R9 手测模板；零生产码），随后 `5f2455b` 由总监实测追认并入
- **总监独立复验**（非采信 worker 自报）：在 HEAD `982af97` 下先 `build.mjs` 重出 dist，再以新 `GX_RB_RUN_DIR=/tmp/gx-rb-lead-1789702637` 重跑，`ROLLBACK_VERDICT=PASS`，R1~R7 全部 exit=0
  - 计时实数（秒）：R1 0.573 / R2 0.582 / R3 0.570 / R4 0.583（on+off 两态共 23 hits）/ R5 0.569 / R6 0.586 / R7 0.605 —— 远低于"行为层 ≤30 分钟"判据
  - R5 netguard 自检先过才允许判绿（防假绿），实得外网出网计数 **0**
  - R7 同时核到 `dist/mcp-stdio.js`（430299 字节）独立 stdio 入口存在
- **R6 历史偏差（已修复）**：计划 §4 R6 写的 `GX_SEARCH_WORKER` 开关曾在 src 零接线；`POST /api/v1/admin/reindex` 真实可用（202→chunks>0/coverage 全 0/rebuilding=false），但**不消化 change_events**（pending 静置不降、done=0）。这不是脚本缺陷而是产品缺陷，已由 `249df44` 修复
- **R6 / R6b 两面（修复后重设计，见 `63fbe71`）**：R6 改看守**回滚面**（显式 `GX_SEARCH_WORKER=off`：pending 静置不降、done=0、手动 reindex 仍可用）；新增 **R6b** 验收**修复正立面**（旗标缺省即起工人：全程不发 reindex 请求，`pending 4→0 / done 0→4`、done 行工牌 `workerId=api-<pid>@<ms>` 4/4、`status chunks.total=7`，2543ms 内完成）。`report.mjs` 的 `allAutoPass` 已纳入 R6b，**R6b 缺失或失败都会让 VERDICT 变 FAIL**，防止未来接线被改掉无人察觉

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

## 7. 默认姿态确认（§4.1）+ 四项签字 — **checklist 已产出，签字未完成**

- 门⑦ checklist（逐条可勾、每条挂硬证据）：`docs/baseline/2026-09-18-m7-checklist.md`（86 条：过 46 / 不过 3 / 未做 26 / 待签字 11）
- 该 checklist 抓出**三处最容易被"绿灯误导"的项**，已按"未做"登记，此处同步明示：
  1. **门③ `ROLLBACK_VERDICT=PASS` 不等于 R8/R9 过**：`report.mjs:47` 的 `allAutoPass` 只统计 R1~R7+R6b，PASS 不含 R8/R9；`/tmp/gx-rb-lead-r6b-1789704671/REPORT.md` 里 R8-1~R8-4、R9-1~R9-4 八行执行人/日期/耗时/断言**全空**，R8 只有静态读码、R9 只确认 runbook 存在（119 行）
  2. **门② 脚本全绿不等于目检段签完**：`scripts/acceptance/R8-manual-checklist.md` RC-13~RC-25 的"结果/验收人/日期"三列全空
  3. **`RELEASE.md` 不是 M7 发布说明**：该文件抬头自带"历史档案声明"，是 2026-09-04 自测记录（最后一次改动 `de6f374`），其中 DATABASE_URL 绝对路径/PostgreSQL 等说法均已过时
- 四项总监签字：authz 姿态、embedding 姿态、Tier-L 措辞、M1 读路径姿态 —— **均未签**，待各项前置证据齐备后签

## 8. 缺陷清单

| 类 | 项 | 状态 |
|---|---|---|
| 已修（本轮） | `5f2455b` TCP 优雅关闭不释放热 WAL（门② CORRUPT 根因） | 总监实测追认，已合入 |
| 已修（本轮） | `e6d493e` sanitize-html data 特判不可达死代码 + 注释谎称 | 等价删除，36 例锁回 |
| 已修（本轮） | `ae65f23` ci-quality 受 shim 劫持假红 | 已合入 |
| 挂账 | C-7 十万节点首屏门（task#158） | backlog，M7 后 |
| 挂账（P2） | 富文本内联 `data:` 图片被 URL 白名单过拦（fail-closed 安全方向正确，功能限制） | 待产品决策，登记 RELEASE 限制 |
| 待观察 | api 全量门在本机 swap 压力下收尾慢/易 flaky | 全量门归 VM/空闲机，需 VM 凭证 |
| **P1 已修（本轮发现·实证）** | **M5 增量索引链路未接线**：`GX_SEARCH_WORKER` 全仓零命中；`SearchIndexer` 从未被 new/start（仅测试实例化）；`reindex.ts` 不碰 outbox。实证：全量 reindex 完成（chunks=5528、coverage 全 0）后 **pending=520 不降** | **已修 `249df44`**：新增 `workerRuntime.ts` 并接线 `index.ts`（TCP + unix socket 两条，SIGTERM 前 stop）、`reindex.ts` 重建期挂起；门控 `GX_M5_SEARCH=on 且 GX_SEARCH_WORKER!=off` 才启动（出厂默认 off）。**行为层证据**：门③新增 R6b（`check-outbox-drain.mjs`）——全程不发 reindex 请求，outbox 自行 pending 4→0、done 0→4、done 行工牌 `workerId=api-<pid>@<ms>` 4/4、`status chunks=7`；R6 改看守回滚面（`GX_SEARCH_WORKER=off` 时 pending 静置不降、done=0）。**默认姿态零副作用**：不设 `GX_M5_SEARCH` 起服，dataDir 只有 app.db（**无 search.db/-wal/-shm**），`search-worker` 日志 0 行。残留观察（不作为阻塞）：`stop()` 是协作式的，挂起瞬间若工人正处理单条，该轮仍可能写旧文件（窗口＝单条处理耗时），彻底消除需给 indexer 加 quiesce 屏障（属改既有语义，未做） |

## 9. 结论

**尚未通过** —— 门①②③④均已过闸（③④为总监独立重跑/独立复算坐实），但门⑤虽判"有条件过"仍需完成"Tier-L 措辞"与"M1 读路径姿态"两项签字，门⑥/⑦未执行，门⑧四项签字未签。
判据（§10.2）中第 5/6/7 条尚不满足，故当前只能登记为"进行中"，不构成放行。
剩余阻塞：**门⑥三环境冒烟**（飞牛/arm 为外部依赖）、**门⑦ checklist**、**门⑧四项签字**、**含 `249df44` 的 api 全量门需重跑**（此前全量跑在该修复之前，不能代表 HEAD）。
