# 计划调整决策：面向 NAS / 最低硬件与通用适配（M0/M1 硬件测试与优化重估）

- 日期：2026-09-12
- 作者 / 裁决：项目总监 大湾区靓仔（综合 M0/M1 实施计划、ADR-0008、ARCH/SPEC/PRD 条文与对落地代码的独立核查后定稿）
- 状态：**Accepted（总监自裁决，本文件即决策）**。下游据此修订各自文档/默认值；作者不得自行把 ADR 翻为更高状态。
- 上游指令（主理人 2026-09-12，原文要点）：未来部署设备存在强不确定性，**初期很可能运行在性能有限的各类 NAS 上**；M0/M1 的硬件承载测试与优化要以**实际最低运行需求 + 通用硬件适配**为依据，**避免围绕 4C8G+SSD / 百万行这类特定高性能配置过度设计**。四条原则：① 逐项分"必须保留 / 可简化 / 可延后"并给依据；② 容灾备份**只预留接入通道、接口、扩展方法，暂不实现完整能力**，但架构上保证未来平滑增加、无需大重构；③ 向量检索**暂不考虑本地模型、仅对接远端 API 模型**，据此简化部署/资源/实现；④ 输出调整点、阶段取舍、后续推进，再继续推进。**其它计划保留不变。**

---

## 0. 结论先行（TL;DR）

1. **本调整不是推倒重来，而是"重新定位 + 收敛验收口径"。** 经独立核查（见 §1 证据），M0 全部切片（S0–S9）、M1 全部切片（S0–S11，含唯一跨端的前端 S8）**均已落地并有测试/提交**；连 age 异地加密备份的代码也已写好，但**默认关闭、需显式 opt-in 与手动 enable timer**；向量检索（M5）则是**零代码、纯规划**。因此本轮几乎不删生产代码，主要工作是：**改"承诺/验收口径"、把默认姿态调成"低配可用"、把完整容灾与本地向量明确后移、把已写好但暂不交付的能力收口为"接口预留、默认关闭"。**
2. **"避免过度设计"的真正杠杆在"验证口径"和"激活默认值"，不在删除已完成的低资源核心。** 写串行队列、EAV sidecar、keyset、物理下推、多 JOIN 计划修复这些**恰恰是低资源 NAS 最需要的**——它们把 O(全表) 与 O(n³) 变成索引 seek/常量页，在慢 CPU、慢盘（HDD/NAS 网络盘）、小内存上收益**比 4C8G 更大**。这些必须保留。要砍掉/后移的是：**围绕"固定 4C8G+SSD、百万行、best-of-5、P95 硬阈值"的那套性能签核仪式**，以及 S5b 那类已被本机 cpu-prof 数据证伪前提的精修。
3. **新验收基线（替代旧"百万行 P95 硬门"）**：在一台**声明的最低参考机**上满足"**小规模真实可用 + 无全表扫描 + 内存有界 + 可回退**"即可放行（见 §5）。大规模数字从"**放行硬门槛**"降级为"**在可得硬件上的参考画像（profile）**"，永远标注机型、不作统一毫秒承诺。
4. **备份分两层重新定位（§3）**：① **本地在线一致性快照**（better-sqlite3 `.backup()` + integrity + manifest + 保留裁剪）——零额外二进制、低资源、已测，**保留为内置基础能力**，它是"防误删/防损坏/升级回滚"的最低安全网，也是未来一切容灾的统一快照原语；② **完整容灾（age 加密 + 异地推送 + 定时启用 + 定期恢复演练）**——**本期只保留接口/挂载点/扩展契约，默认关闭、不作为交付验收项**。代码已在，不删，但文档与部署默认值明确标注"接入预留、未激活"，未来新增 `BackupTransport` 实现即可平滑接入，无需重构。
5. **向量检索（M5）默认改为"仅远端 API embedding"（§4）**：不内置、不默认装配任何本地推理模型/权重/ONNX 运行时；`EMBEDDING_MODE` 默认从 `local` 改为 `cloud（远端 OpenAI 兼容）/ off`，`off`（纯 FTS5/trigram + LIKE 回退）为无远端配置时的可用降级。`EmbeddingProvider` 抽象本就存在，"未来再加本地 provider"是纯增量、不动接口。这样 NAS 上零推理内存/磁盘/指令集负担，也消除原方案最大的硬件不确定项（老 Xeon/arm、无 AVX、2C4G 能否跑 bge）。

---

## 1. 独立核查：现状到底落了什么（不采信任务状态，以文件/提交为准）

> 方法：不看任务板"completed"字样，直接 `ls`/`grep`/`git log` 核文件存在性、默认值、接线点、提交。以下均在工作树实测。

### 1.1 M0 生产基座（已落地）

| 能力 | 落地证据（文件） | 默认姿态 |
|---|---|---|
| 可运行生产构建（修 B0/D1） | `apps/api/scripts/build.mjs`（esbuild 扁平单文件）、ADR-0021 | 已是构建方式 |
| 版本单源 | `apps/api/src/version.ts`、`healthz/readyz` 引用 | — |
| 配置 fail-fast 闸门 | `apps/api/src/config.ts`；生产拉黑开发默认 JWT | 生产 fail-closed，test/dev 放行 |
| 健康探针 | `apps/api/src/routes/healthz.ts`、`readyz.ts`、`src/ops/readiness.ts`（5 探针） | 常开，**低资源友好** |
| 安全头/体限/限流/审计 | `src/middleware/*`、`src/audit/*`、logrotate 片段 | 常开（限流内存固定窗，极小开销） |
| **本地在线备份** | `src/ops/backup.ts`、`scripts/backup/{online-backup,verify-restore,lib}.mjs`、ADR-0007 | **本地快照默认可用；age 异地分支 `BACKUP_ENCRYPT_OFFSITE` 默认非 true** |
| **age 异地加密（完整容灾）** | 同 `online-backup.mjs:104-133`（age/rsync/挂载推送）、ADR-0010、`deploy/systemd/gouxiangdb-backup.{service,timer}` | **opt-in：需显式 env + 装 age + 手动 `systemctl enable --now timer`** |
| CI 质量门 | `scripts/ci-quality.sh`、根 `eslint.config.js`、`.workflow/ci.yml` 模板 | 平台中立，本机/任意 Linux 可跑 |
| 裸机部署物 | `deploy/{systemd,caddy,bin,env.conf.example,logrotate,probe}` | 单实例、同机、零额外运行时 |

要点：`deploy/bin/deploy.sh:75-77` 的"发布前快照"调用的是**本地在线备份**（前置版本目录里的 `online-backup.mjs`），**不依赖 age/异地**，因此把完整容灾后移不影响升级安全网。

### 1.2 M1 数据底座（已落地，读新路径默认 off / shadow）

| 切片 | 落地证据 | 默认姿态（关键） |
|---|---|---|
| S1 写串行队列 | `src/db/writeQueue.ts`、`resolveWriteQueueEnabled`（`:96-101`） | `GX_M1_WRITE_QUEUE` 未设置/on 启用，`=off` 旁路；语义等价 |
| S2 raw 只读网关/keyset 原语 | `src/db/rawRead.ts` | 新模块 |
| S3 sidecar DDL | 迁移 `20260913062000_record_field_index_sidecar`（迁移 11→12） | 只增，可 truncate 重建 |
| S4 sidecar 同事务写维护+回填 | `src/domain/fieldIndex/{policy,sync}.ts`、`scripts/bench/backfill-sidecar.ts`、`check-sidecar.ts` | **写维护默认常开，读默认不用**；`GX_M1_SIDECAR=off` 全旁路 |
| S5 hydration 批量化+消全表回查 | `src/domain/hydrateBatch.ts` + `hydrate.ts` 两阶段 | flag 可回退；S5b-P1 已锁环 golden |
| S6 物理下推/unique 走索引/算符回退 | `src/domain/queryPlan/{compile,sidecarQuery,...}.ts`、`#94` 多 JOIN `INDEXED BY rfi_record_field_ord_key` 修复 + EXPLAIN 形状测试 | **读新路径需显式开** |
| S7 keyset 分页 + COUNT 下推 + shadow | `src/domain/recordService.ts`、`queryPlan/keysetEntry.ts`、`paginate.ts`、shared additive 三键 | **`GX_M1_SIDECAR_READ=off`（默认）走旧全表内存路径；`GX_M1_KEYSET=off`（默认）；`=shadow` 纯观测对拍** |
| S8 前端游标/有界全量/置灰 | 提交 `0b88d92`、`c358a97`；`apps/web/src/api/records-paging-hooks.ts`、`records-paging.ts`、GridView/Kanban/Calendar/Gallery/CellEditor 改造 | 增量，旧 `useRecords` 保留可回退 |
| S9 生成器/压测脚手架 | `scripts/bench/{gen-data,run-gate,load,scenarios,write-contention,...}.ts` | 纯脚本，不进服务 |
| S10 证伪门 + cpu-prof | `run-gate.ts`、`server.ts --cpu-prof`、`cpuprof-report.mjs`、`audit-server-log.mjs`、ADR-0008 | 手动触发，不入每次 push |
| S11 收口 | ADR-0004 Accepted、40 RC 回归、边界登记 | — |

> 核查中一度因 shell 的 `--include` 通配报错误判"S8 前端未做"，改用 `git log -- apps/web` 与直接列文件后纠正：**S8 已交付**（`records-paging-hooks.ts` 等在）。记录此条以表明结论来自实测而非任务板。

### 1.3 向量检索（M5，零代码）

- 代码侧**无任何 embedding / transformers / sqlite-vec / search.db 实现**（`grep` 全仓 src 无对应模块）。全部内容在规划文档：SPEC-enterprise §技术栈（`:52-53`）、ARCH-enterprise §7（`:613-744`）、ADR 槽位 **0016（Embedding 双模式）/ 0017（sqlite-vec/LanceDB）仅在 ARCH §10.4 列表中被引用，尚无 ADR 文件**；`docs/adr/` 实际只有 0001–0010、0021。
- 原方案默认本地：`@huggingface/transformers` + `Xenova/bge-small-zh-v1.5`（512 维，q8 ONNX 30–100MB、驻留 200–400MB、Worker Thread），云端为可选；并自带"2C4G x64 未知 → 首日 spike，不达标默认 off"的风险项（ARCH `:667-672`、`:955-956`）。**本期决策把这个最大不确定项直接移除：默认只走远端。**

---

## 2. M0/M1 硬件测试与性能优化：逐项三分类

分类准绳（以"对低配 NAS 的边际价值 / 是否绑定特定高性能假设 / 是否已被数据证伪"三条衡量）：

- **必须保留**：在慢 CPU、慢盘、小内存上把开销从"随行数/连接数膨胀"变成"有界/索引化"的能力，或与性能无关的正确性、安全、可观测底座。
- **可简化**：能力本身有用，但**验收/度量方式绑定了固定规格机/百万行/P95 硬阈值/best-of-5**；改为"低配参考机的小规模可用性 + 自适应/有界 + 参考画像"。
- **可延后**：只有在远大于初期 NAS 的规模/扇出下才有收益、或前提已被本机数据证伪、或属于"完整容灾/本地推理"这类与本期定位不符的投入。

### 2.1 必须保留（KEEP）——低资源 NAS 下价值更高，不动

| 项 | 位置 | 为什么在 NAS 上更要留 |
|---|---|---|
| **进程内写串行队列**（S1） | `db/writeQueue.ts` | 把"并发→SQLITE_BUSY 失败（实测约 50%）"变成"并发→排队"。**慢盘下写锁持有更久，BUSY 概率更高**，队列是慢盘友好的正确性兜底，零外部依赖。保留常开默认。 |
| **WAL + busy_timeout 就绪收口**（M1 对 db.ts D14） | `db.ts` | WAL 在多读单写、崩溃恢复上对 NAS 盘更稳；busy_timeout 缓冲突发写。 |
| **EAV sidecar 物理旁路索引**（S3/S4） | 迁移 12、`fieldIndex/*` | **这是反全表扫描的核心**。HDD/网络盘随机 IO 极慢，一次 `SCAN records` 在 NAS 上的代价是 SSD 的数十倍。把物理字段等值/范围/排序转为索引 seek，低配收益更大。派生表可 truncate 重建、写时同事务维护，存储/CPU 代价可控。 |
| **keyset/游标分页 + COUNT 下推 + LIMIT 短路**（S2/S7） | `rawRead.ts`、`keysetEntry.ts`、`paginate.ts` | 禁 offset 深翻、首页由覆盖索引 + `LIMIT 101` 恒定，**直接决定小内存下"翻页不随表变大而爆内存"**。 |
| **多字段高命中 AND 多 JOIN 计划形状修复**（#94） | `queryPlan` `INDEXED BY rfi_record_field_ord_key` + EXPLAIN 形状测试 | 修复前是 **O(n³)（三字段宽 AND 数小时级）**。这不是"高性能优化"，是"防止某类普通筛选在任何机器上直接拖死"。慢 CPU 上更是必须。EXPLAIN 形状测试防回归，廉价，保留。 |
| **hydration 批量化 / 消灭"写一行=全表两轮 hydration"**（S5） | `hydrateBatch.ts`、`hydrate.ts`、records POST/PATCH/详情改单行 | 把查询数从"随行数×字段×关联层连乘"降为按层常量。**小内存下全表 hydration 是 OOM 首因**（500k jetsam 形态即此）。这是内存有界的关键，必须留。 |
| **hydration 记录预算双界 [400,2000] + BFS 深度闸**（`7c7b3c0`） | `hydrateBatch.ts` | 给 mega-hub 关联扇出封顶，防内存无限膨胀。**这正是"通用硬件适配"意义上的保护**，保留。 |
| **有界全量 + 明确降级提示**（前端 S8） | records-paging-hooks、看板/月历/画廊 bound、计算字段置灰 | 超 bound 提示而非静默假全量/白屏；大表计算字段排序筛选置灰。**与"不强求百万行"完全一致**，保留并据 §5 把 bound 默认设给低配。 |
| **healthz/readyz、配置 fail-fast、安全头/限流/审计**（M0 S3/S4/S5） | 见 §1.1 | 与性能无关的正确性/安全底座；readyz 的磁盘/迁移探针在 NAS 上更有用（盘小、易满）。保留。 |
| **平台中立 CI / esbuild 扁平产物 / 裸机部署 / 单实例同机拓扑**（M0 S2/S7/S8） | ci-quality.sh、build.mjs、deploy/* | 单文件产物 + 零外部运行时 + 单实例，本就是最低资源形态；better-sqlite3 预编译按 arch 取包，天然适配 x86/arm NAS。保留，补 arm64 打包说明即可（§5.4）。 |
| **本地在线一致性快照（备份层①）** | `ops/backup.ts`、ADR-0007 | 零额外二进制、开销低，是最低安全网与统一快照原语。**保留为内置基础能力**（细节 §3）。 |
| **不迁 PG、保方言通道**（ADR-0008/0002） | sidecar 普通表、参数化、可移植 ORDER BY/upsert | 零外部依赖是 NAS 私有化的核心竞争力。保留 SQLite，PG 维持"阈值触发、不投实施成本"。 |

### 2.2 可简化（SIMPLIFY）——保留能力/工具，但验收与默认口径从"规格机硬门"改为"低配可用 + 参考画像"

| 项 | 原口径（绑定高性能假设） | 调整后口径 |
|---|---|---|
| **S10 证伪压测门的"硬阈值签核"**（M1 计划 §S10 表、ADR-0008 T1） | 固定 **4C8G+SSD 规格机、best-of-5、50万 P95<800ms / 100万<1.5s**，作为 M1 放行/迁 PG 的硬裁决 | 放行只看 §5 的**最低参考机"小规模可用 + 无 SCAN + 内存有界 + 可回退"**。50万/100万数字降级为**在可得硬件上的参考画像**（注明机型/冷热/盘型，E2/E3，不作统一毫秒承诺、不作为门槛）。run-gate/gen-data/audit 工具保留（有用、零服务开销），但**不再要求必须有规格机才能收口**。 |
| **ADR-0008 T1 触发条件** | "固定规格 4C8G+SSD best-of-5 上 100万 P95≥1.5s（≥3/5 轮）"才谈迁库 | 改为**硬件无关的相对/症状触发**（§5.3）：在**完成应用层手段后**，于**真实目标机/最低参考机**上，代表性日常工作负载（不是人造百万行）默认列表持续超用户可接受阈值、或 RSS 触顶/被 OOM、或写排队超时——**并先穷尽调索引/调 bound/关重活**才议 PG。T0（harness 自身可信）、T2（千万行）、T3（100GB）、T4（持续百写 QPS）、T5（多实例/SaaS）维持不变，它们本就与规格机无关。**§3.3 的宽命中 COUNT 线性（500k ~11-12s）登记为已知边界，不作为本期迁库依据。** |
| **S9 数据生成档位** | 必跑 1万/10万/50万/100万 × 宽/窄 | 生成器保留（确定性可播种，本身有价值）；**常规回归只跑 1k/1万/10万 三档**验证"有界/无 SCAN/对拍 drift=0"。50万/100万改为"有条件/可选"，谁需要谁在自己机器上跑，不阻塞里程碑。 |
| **S5b 计划的"规格机 best-of-5 复核"表述** | 多处 E3 数字"待 4C8G+SSD 规格机复核"才进结论 | 该等待前提取消：E3 本机数字可作为**方向性参考**直接用于决定"做不做某优化"，只是不写成对外毫秒承诺。配合 §2.3，S5b-Ⅱ 据此正式不做。 |
| **大表计算字段置灰阈值（S8）** | "沿用 10 万行档，S10 后定"，原按 4C8G 标定 | 阈值改为按**最低参考机**标定并**可配置 + 自适应**（见 §5.2 的 bound 矩阵），默认给低配保守值；高端机可调高。不再追求单一固定行数。 |
| **`GX_M1_*` 读新路径的上线节奏** | 计划假设 shadow 一迭代 0 drift 后在规格机验证再全量 on | 因读路径默认 off，**低配机默认继续走旧内存路径有 OOM 风险**。调整为：在 §5 最低参考机上用 1万/10万档完成 shadow drift=0 + 内存有界验证后，**把 keyset+sidecar 读在低配默认置 on（异常自动回退旧路径的机制保持）**，让低配默认享受有界/索引路径；旧路径保留可一键 off 回退。这是"默认姿态面向低配"的关键改动。 |
| **监控 metrics / cpu-prof / 慢查询埋点** | 部分以"找百万行瓶颈"为目的 | 工具保留；定位改为**低配运维可观测**（RSS、写队列等待、BUSY 数、readyz、磁盘余量、慢请求计数），默认轻量、按需开启详细 query 日志（现状已是 `GX_LOG_SLOW_MS` opt-in，保持）。 |

### 2.3 可延后（DEFER）——本期不投入，留接口/登记，未来需要时再做

| 项 | 依据（为什么低配初期不需要） | 未来如何平滑接入 |
|---|---|---|
| **S5b-Ⅱ 字段投影器（治 C-compute）** | **前提已被 P2 cpu-prof 数据证伪**：点引三函数 self 合计仅 busy **1.15%**（`docs/baseline/2026-09-14-s5b-cpuprof-attribution.md`），真热点是 idle 等 IO 45%、parseStored 等。为 1.15% 去重写点引用核心路径，在低配小数据集上**零可感收益、高回归风险**。正式后移（任务 #89 的 Ⅱ 部分）。 | hydration 两阶段+mergedCache 结构已在；真到超大宽表点引用变慢，再按 S5b 计划做投影器，接口不需现在改。 |
| **S5b-Ⅰ prefetch 边剪枝（治 C-io/oof）** | 收益是"少查无引用关系的 owner link 行"，在 10k 小表本机测不出；只在 100k/500k mega-hub + 高并发下显著。初期 NAS 数据量小，**延后**。 | `GX_HYDRATE_PRUNE` flag 规格 S5b 计划已备；实现是加一个被引字段闭包过滤，纯增量。展示列 LinkRef 不剪的红线保留。 |
| **第三类成本：展示列 LinkRef 标题物化**（buildLinkRefs/primaryTitle，inclusive 24–30%） | 这是"为显示关联标题而逐 id 取标题"的成本，量级真实但只在大 hub 显现；属优化项非正确性项。本期**登记不做**。 | 未来可批量取标题/缓存；走同一 BatchStore，增量。 |
| **宽命中 filteredTotal COUNT 的 rfi-only 计数优化**（ADR-0008 §3.3，500k ~11-12s） | 只在"统计一张表的大部分行"时线性；首页 keyset 恒定 5ms 不受影响。NAS 初期不会有 50 万行宽命中统计。**延后**；动计数路径前须先核实软删 rfi 行随删同事务清理（ADR 已注明前置）。 | 独立候选片，不影响首页/分页。 |
| **百万行 / 50万终验、jetsam OOM 系统取证** | 绑定高性能规格机，与本期"最低硬件可用"目标不符。 | 有真实客户接近该规模时再按画像流程跑；阈值 T2/T3 仍兜底。 |
| **完整容灾能力**（age 加密异地、rclone/rsync 推送、timer 默认启用、半年期解密恢复演练） | 主理人明确：本期只预留接入，不实现/不激活完整能力。代码已在但默认关、不验收。 | 见 §3 的 `BackupTransport` 扩展契约——加一个 transport 实现 + 配置即可，无重构。 |
| **本地 embedding 模型 / sqlite-vec 之外的重检索组件、reranker、多模态** | 主理人明确：向量只接远端 API；本地推理在 NAS 上是负担与兼容风险。M5 本身排在后续里程碑。 | 见 §4：provider 抽象已设计，未来加 `LocalEmbeddingProvider` 为纯增量；reranker/多模态本就在"不做"清单。 |

---

## 3. 备份：本地快照留作基础能力，完整容灾只留接口（满足"平滑增加、无需重构"）

### 3.1 两层切分（与主理人"只预留接入通道、接口、扩展方法"对齐）

| 层 | 内容 | 本期定位 |
|---|---|---|
| **层① 本地在线一致性快照** | better-sqlite3 `.backup()` 合并 WAL 成干净文件 + `integrity_check` + 迁移数 + 关键表计数 + manifest/sha256 + daily7/weekly4 本地保留（`ops/backup.ts`，ADR-0007） | **保留为内置基础能力**（默认提供手动/升级前快照），但**不默认启用每日 timer**（NAS 初始可由用户在管理页/脚本一键开本地定时，属轻量本地操作，不含异地/加密）。理由：它零额外二进制、不联网、开销低，是防误删/损坏与升级回滚的最低安全网，且是未来所有容灾的统一"快照原语"。 |
| **层② 完整容灾（异地/加密/调度/演练）** | age X25519 加密 + `GX_OFFSITE_TARGET`（rsync/挂载）推送 + offsite spool + systemd timer 每日启用 + 季度/半年期"解密恢复"演练（`online-backup.mjs:104-133`、ADR-0010、backup.timer） | **本期＝接口预留，默认关闭、不交付、不验收**。代码保留在仓（已写已测），但：不在部署文档里把它写成"已具备的容灾能力"；`deploy` 不 `enable` timer；env 模板里这组变量标注"可选扩展，默认不启用"；ADR-0010 状态/标题加"**接口预留，未激活**"说明。 |

> 说明：主理人原话"容灾备份当前只预留接入通道……暂不实现完整能力"。层①的本地快照是**单机防丢数据的最低底线**，不是"完整容灾"（完整容灾指防整机/机房损毁的异机/异地副本）。把层①保留为默认基础能力、层②收口为预留，既落实"不实现完整容灾"，也不违背工程最低安全底线；若主理人希望层①也默认不启用定时，当前实现本就需手动 enable，无冲突。

### 3.2 "未来平滑增加、无需大重构"的架构边界（本文件把它冻结为契约）

现状代码已天然分层，本文件把它显式化，确保后续加异地/加对象存储/加 NAS 共享目录时**只增实现、不改快照核心**：

1. **快照原语与投递解耦（已具备，固化为接口）**：
   - `backupDatabase(src, dest)` / `inspectSnapshot(file)` / `buildManifest()` / `selectRetention()`（`ops/backup.ts`）是**纯快照+校验+保留**核心，不感知"副本去哪"。
   - age 加密 + `pushOffsite()`（rsync `host:path` 或本地挂载 `fs.cpSync`）是 `online-backup.mjs` 里快照**之后**的可选投递步骤。
   - **冻结的扩展点**：定义一个投递契约（后续可落成 TS 接口，当前先用文档契约）：
     ```
     BackupTransport {
       id: string;                       // "local-dir" | "age-rsync" | "s3" | "nas-share" ...
       push(artifact: { dbFile, uploadsTar?, manifest }, cfg): Promise<{ ok: boolean; ref?: string }>;
       verify?(ref): Promise<boolean>;   // 可选回读校验
     }
     ```
     未来新增异地能力＝新增一个 `BackupTransport` 实现并在配置里登记，**快照/manifest/校验/保留核心一行不动**。现有的 age-rsync 分支就是该契约的一个已写好但默认不注册的实现样例。
2. **配置即开关，无代码分叉**：层②由 `BACKUP_ENCRYPT_OFFSITE` / `AGE_RECIPIENT` / `AGE_BIN` / `GX_OFFSITE_TARGET` 驱动，缺失即"不投递、只留本地（或只留 spool 并告警）"。未来"启用容灾"＝填配置 + enable timer，不需要改代码/迁移/表结构。
3. **调度独立**：备份是独立 oneshot 脚本 + systemd timer，与 API 进程解耦；未来换调度（cron/管理页按钮/定时器）只换触发方式。
4. **数据模型零耦合**：备份只读源库、写新文件，不进业务写路径、不进 schema；启用/停用容灾对在线服务零影响。
5. **恢复路径已留**：`verify-restore.mjs` + restore/wal runbook 已在，未来异地副本的恢复＝先取回本地再走同一套 verify/restore，不需要第二套恢复逻辑。

结论：**"只预留接口、未来平滑加"的要求，当前架构已满足且本文件将其固化为契约**；本轮只需把 ADR-0010/部署/env 模板的"已激活"语气改为"接口预留、默认关闭"，并在 `online-backup.mjs` 顶部/`ops/backup.ts` 注释标明层②为可插拔 transport（可选做一个不破坏行为的小重构把 push 段收敛到明确的 transport 边界，标低优先，不阻塞）。

---

## 4. 向量检索：默认仅远端 API，简化部署/资源/实现

适用范围：M5（企业版统一检索）相关规划——SPEC-enterprise §技术栈、ARCH-enterprise §7、PRD D-1/V1/V4、ADR 槽位 0016/0017。M1 本就不建主库 FTS/向量（边界不变）。

### 4.1 决策

- **Embedding 唯一默认来源＝远端 OpenAI 兼容 API**（`EMBEDDING_CLOUD_BASEURL` + key + model/dim），支持客户自填任意兼容端点（通义/豆包/混元/Jina/内网 vLLM/网关等）。
- **不内置、不默认安装任何本地模型**：移除默认 `@huggingface/transformers` + `Xenova/bge-small-zh-v1.5`、q8/fp32 权重随包预置、Worker Thread 本地推理、"干净 Linux 2C4G 本地模型 spike"作为发版前置等内容。
- **三态简化为两态半**：`cloud`（配置了远端即为默认/唯一启用路径）与 `off`（未配置或显式关→纯 FTS5/trigram + 短词 LIKE 回退，功能不瘫）。`local` 从默认/必备降级为**未来可选 provider**，本期不实现、不打包、不写进部署必备清单（接口保留）。
- 数据出域是远端模式的固有代价：沿用既有红线——**切云端需管理员显式配置并二次确认、key 走 600 env 不入库不入日志**；`off` 保证"不想出网/无网"的 NAS 仍有关键词检索可用。

### 4.2 据此简化掉的东西

| 原本地方案的成本/风险（NAS 上尤其敏感） | 调整后 |
|---|---|
| ONNX 运行时 + 30–100MB 权重随安装包/内网镜像预置 | **删除**：包体变小，无模型文件分发 |
| 模型驻留 200–400MB 内存、Worker Thread 占 CPU | **删除**：NAS 2C4G/小内存不被推理挤占，主应用与检索不抢 CPU |
| 老 Xeon / arm / 无 AVX 指令集兼容风险（ARCH 已列中风险） | **删除**：零原生推理依赖，arch 适配面只剩 better-sqlite3 |
| "2C4G x64 本地模型 spike，不达标默认 off"的发版前置与不确定性 | **删除**：不再有这个 gate；M5 首日 spike 清单改为"远端连通性/鉴权/超时/降级 + FTS/trigram 正确性" |
| 本地/云端双模式维度漂移需重建索引的复杂默认路径 | 单一远端 provider；维度仍随 model 元数据、变更触发 reindex（既有逻辑保留），但无 local↔cloud 双默认 |

### 4.3 仍要保留的（与本决策不冲突）

- **独立派生库 `search.db` + better-sqlite3 旁路**：不污染主 WAL、可 truncate 重建、备份分离——这个设计与"本地/远端 embedding"**正交，保留**。向量存储仍可用 sqlite-vec（轻量、纯库、无推理负担）；存的是远端返回的向量。ADR-0017（sqlite-vec/LanceDB 阈值）规划仍成立。
- **`EmbeddingProvider` 抽象**（ARCH §7.2 已定义）：保留。未来要加本地模型＝新增一个 `LocalEmbeddingProvider` 实现并 opt-in，**接口、search.db、混合检索/RRF、权限收敛都不动**——即"现在不做本地，但未来加本地无需重构"，与备份同构。
- **FTS5/trigram + 1-2 字短词 LIKE 回退 + RRF 混合 + 先按权限收敛再召回 + 崩溃降级 fts-only + 幂等 reindex**：全部保留，它们是检索正确性/安全/降级底座，与 embedding 在哪算无关。
- 语义检索 P95 目标：原"<500ms（本地 GPU 档）"的硬件分档承诺改为**远端口径**（主要取决于网络与远端 SLA），产品上不给统一硬毫秒承诺，按实测展示。

### 4.4 文档动作（M5 开工前完成即可，本文件先冻结方向）

- SPEC §技术栈 `:52-53`、PRD D-1/V1、ARCH §7.2/§7.6/风险表/外部输入、§10.4 ADR-0016 描述：统一改为"**远端 API 默认/本地为未来可选 provider/off 降级**"；ADR-0016 标题/状态在 M5 落地时相应改写（当前 0016 无实际文件，仅引用，不产生翻状态问题）。

---

## 5. 新验收基线：最低参考机 + 通用适配（替代规格机硬门）

### 5.1 最低参考机定义（先按此标定，拿到真实 NAS 清单后回填修订）

- **参考下限（Tier-L，验收用）**：2 核 x86_64 或 arm64、**4 GB 内存**、**机械盘或典型 NAS 网络盘**（非 SSD）、Linux + Node ≥20。这与 ARCH §4.1"最低 2C4G"对齐，但把盘从隐含 SSD 显式改为**按慢盘验收**。
- 参考上限不设固定机型；4C8G+SSD 仅作为"更高档表现"的可选画像，不是门槛。
- 目标数据画像（初期 NAS 真实区间）：**单表活跃 1万–10万行**为流畅设计点；50万为"可接受降级/有界"画像；百万不作为初期目标。单库 ≤20GB、10–50 并发、峰值写 10–20 QPS 的既有私有化假设不变。

### 5.2 Tier-L 上的放行准则（DoD，替代旧 P95 硬表）

在 Tier-L 参考机（或可得的最接近机器，明确标注规格）上满足即可放行，不要求 4C8G/SSD/百万：

1. **小规模日常可用**：1万行默认列表首页、翻页、物理字段等值/范围筛选、单选/多选、数字/日期排序，交互**可接受**（给工程目标而非对客硬承诺：首页/命中筛选服务端 < 约 300–500ms 量级；机械盘可放宽，以"实测记录 + 无 SCAN"为准，不卡 best-of-5）。
2. **无全表扫描**：上述物理路径 `EXPLAIN QUERY PLAN` 命中 `records_table_live_created_id` / `rfi_table_field_*`，不得出现 `SCAN records` / `SCAN record_field_index`；多 JOIN 由 records 覆盖索引驱动（#94 形状测试）。**这是慢盘上最关键的一条，且与硬件档位无关。**
3. **内存有界**：宽表列表/翻页 RSS **不随总行数线性放大**（10万 vs 1万给倍数说明，由 keyset 页 + hydration 预算 [400,2000] + 有界全量保证）；不出现 jetsam/OOM。
4. **大表有明确降级而非白屏/假全量**：超 bound 的看板/月历/画廊给"缩小范围"提示；计算字段大表排序/筛选置灰。bound 默认按 Tier-L 设**保守值并可配**（建议起点：分组有界全量 `GX_M1_GROUP_BOUND=5000`、内存精修 `GX_M1_INMEM_LIMIT=20000`、网格默认页 100–200；最终在 Tier-L 实测回填，避免拍脑袋）。
5. **并发写零 BUSY**：Tier-L 上 batch=20 混合写，经写队列后无 SQLITE_BUSY（慢盘下重点验证）。
6. **可一键回退**：三个 `GX_M1_*` flag 关回退到 M0 行为；但按 §2.2，**在 Tier-L 完成 shadow drift=0 后，默认改为 keyset+sidecar 读 on**（异常自动回退旧路径保持），让低配默认走有界/索引路径。
7. **平台中立**：CI 在普通 Linux  runner 全绿；better-sqlite3 有目标 arch（x86_64/arm64）预编译；不依赖客户机装 sqlite3/age（age 本就 opt-in 后移）。

### 5.3 ADR-0008 T1 的硬件无关改写（迁 PG 触发，替换"4C8G 百万行"那半句）

> T0/T2/T3/T4/T5 不变。仅把 T1 从"固定规格机百万行 P95"改为"真实目标机 + 真实负载 + 症状 + 已穷尽应用手段"。

**T1（修订）**：在 A1/A2/A4/A5/A6 及 hydration 收口（S5）已上线、sidecar drift=0、EXPLAIN 无 SCAN、计算字段已按规置灰、**且已完成调索引/调 bound/升 better-sqlite3 等二次尝试**的前提下，于**真实部署机（含最低参考机）**上出现下列任一**持续症状**（非压测瞬时尖峰）：① 代表性日常工作负载的默认列表/命中筛选延迟持续超出可接受区间（连续观察，而非 best-of-5 单轮）；② 列表 RSS 持续触顶并引发 OOM/被系统杀；③ A6 串行化后仍出现写排队超时——方可立项议迁 PostgreSQL。**单纯"计算字段/全文搜索慢"或"人造百万行宽 COUNT 慢"仍不触发。** 百万行/best-of-5 数据降级为参考画像，不再是 T1 的必要条件。

### 5.4 通用硬件适配的小清单（低成本、本期可做）

- 部署/打包 runbook 显式覆盖 **arm64 + x86_64** 的 better-sqlite3 预编译取包（M0 已提交叉 arch，补 NAS 常见 arm 设备说明）。
- readyz/文档给出**磁盘余量、WAL 体积、内存、备份目录占用**的低配运维视图；`GX_MIN_DISK_BB` 默认对小盘友好（评估从 1024MB 下调或可配）。
- 不假设 SSD：任何"性能"默认值都以慢盘不被随机扫描拖垮为准（已由索引/有界路径覆盖）；不依赖 `drop_caches` 等特权操作。
- esbuild 单文件 + 裁剪 node_modules 的发布物保持精简，减少 NAS 上安装/落盘体积。

---

## 6. 阶段取舍与后续推进安排

原则：**其它计划保留不变**；只调整与"硬件假设/完整容灾/本地向量"相关的部分。M0/M1 已落地，本轮以"文档/默认值收口 + 低配默认姿态"为主，不回滚已完成的低资源核心。

### 6.1 立即（本次调整，纯文档 + 少量默认值，低风险）

1. 本决策文件入仓（本提交）。
2. 由架构师据此产出/修订（送总监终审，不得自行翻 ADR 状态）：
   - ADR-0008 增补"**2026-09-12 NAS 重定向**"小节：T1 按 §5.3 硬件无关改写、百万/best-of-5 降为参考画像、明确 S5b-Ⅰ/Ⅱ 与第三类成本后移；**Accepted 覆盖范围不变**，不重开迁库结论。
   - ADR-0010 标注"**接口预留，默认不激活**"；ADR-0007 注明"本地快照＝内置基础能力，异地容灾为可插拔 transport、见 ADR-0010/PLAN-ADJUST"。
   - M1 实施计划 §S10/§8/§9 与 ARCH-production §3.4/§5.1/§6：把"4C8G+SSD 规格机硬门/best-of-5/百万放行"改写为 §5 基线（保留工具、改验收口径）。
   - `deploy/env.conf.example`、`docs/runbooks/deploy.md`、`backup.md`：备份层②变量/timer 标"可选扩展、默认关"；部署不 enable 备份 timer（本地定时由用户按需开）。
3. 后端做一个**行为中性的小核对**（可并入上述提交或紧随）：确认生产默认 `GX_M1_SIDECAR_READ`/`GX_M1_KEYSET` 确为 off、`BACKUP_ENCRYPT_OFFSITE` 默认非 true、timer 不被 deploy 自动 enable（与 §1 核查一致即可，无需改码；若有偏差再改默认值）。

### 6.2 近期（M1 面向低配的收尾，让低配默认走"有界/索引"路径）

4. 在 **Tier-L 最低参考机（或可得最接近机器）**跑 1k/1万/10万 三档：shadow 对拍 drift=0、无 SCAN、RSS 有界、并发写零 BUSY；据此**回填 §5.2 的 bound 具体默认值**，并把"低配默认 keyset+sidecar 读 on（自动回退保底）"作为一次受控切换（flag 默认值调整 + 一条 release note），旧路径保留可关。
5. 前端 S8 已有降级/置灰接 §5.2 的可配 bound，做一次联调冒烟（网格游标累积、看板/月历超 bound 提示、关联选择器限量、无裸 fetch/无新依赖）。
6. 关闭/收敛任务 #89：**S5b-Ⅱ 正式取消（前提证伪）、S5b-Ⅰ 与第三类成本/宽 COUNT 优化一并登记为"按规模触发"的延后候选**；在任务与 ADR 里写明触发条件（出现 100k+ mega-hub 真实负载或 cpu-prof 复热点），避免遗忘也避免过早投入。

### 6.3 后续里程碑（方向冻结，不阻塞）

7. M2（附件外置等）、M5（检索）、M6（标准 MCP 唯一 AI 入口）、M7（总验收）按原计划推进。M5 开工时按 §4 把规划改为"远端 embedding 默认 + EmbeddingProvider 留本地未来位 + off/FTS 降级"，并据此写 ADR-0016/0017；不再安排本地模型低配 spike 作为前置。
8. 备份层②（异地容灾）**不在里程碑路线上占工期**；当出现真实客户需求（异机/对象存储/NAS 共享目录/加密合规）时，按 §3.2 的 `BackupTransport` 契约新增实现 + 配置启用即可，无需改快照核心。

### 6.4 明确不做（防止范围回流）

- 不删 M0/M1 任何已落地、已测、低配有益的核心（写队列/sidecar/keyset/下推/多 JOIN 修复/hydration 批量化与预算/有界降级/健康安全底座/本地快照）。
- 不为"证明百万行"去采购/等待固定 4C8G+SSD 规格机，不把 best-of-5 当放行前置。
- 不在 NAS 上默认启用本地推理模型；不在本期实现/激活完整异地容灾。
- 不因本次调整迁 PostgreSQL（阈值 T2/T3/T4/T5 远未触及，T1 改为更难被人造压测误触发）。

---

## 7. 对主理人四原则的逐条对应（验收对照）

1. **逐项"必须保留/可简化/可延后"+依据** → §2 三分类表（每项含位置与"为何在 NAS 上如此取舍"）。
2. **容灾只预留接口、未来平滑加、无需重构** → §3：层①本地快照留基础、层②完整容灾默认关不验收；`BackupTransport` 契约 + 配置即开关 + 调度独立 + 数据模型零耦合 + 恢复路径复用，证明无重构平滑接入。
3. **向量仅远端 API、简化部署/资源/实现** → §4：默认 cloud/off、删本地模型与 spike 前置与资源占用；EmbeddingProvider 留本地未来位，search.db/sqlite-vec/FTS/RRF/权限/降级全保留。
4. **输出调整点/阶段取舍/后续推进并继续** → §5（新低配验收基线 + T1 硬件无关改写）、§6（立即/近期/后续/不做）。**其它计划保留不变**（§6 开头与 §6.3 明确 M2/M5/M6/M7 原计划推进，仅 M5 向量默认与备份/验收口径按本文件调整）。

---

## 附：本次核查用到的关键锚点（便于复验）

- M0/M1 落地：`apps/api/scripts/build.mjs`、`src/{config,version}.ts`、`src/routes/{healthz,readyz}.ts`、`src/ops/{readiness,backup}.ts`、`src/db/{writeQueue,rawRead}.ts`、`src/domain/fieldIndex/{policy,sync}.ts`、`src/domain/queryPlan/*`、`src/domain/{hydrate,hydrateBatch,recordService}.ts`、迁移 `20260913062000_record_field_index_sidecar`、`scripts/bench/*`、`scripts/ci-quality.sh`、`deploy/*`。
- 前端 S8：提交 `0b88d92`、`c358a97`；`apps/web/src/api/records-paging{,-hooks}.ts`。
- 备份层② opt-in：`apps/api/scripts/backup/online-backup.mjs:29-32,104-133`；`deploy/systemd/gouxiangdb-backup.{service,timer}`；`deploy/bin/deploy.sh:75-77`（只调本地快照）；ADR-0007/0010。
- 性能/扇出：ADR-0008 §3（三形态）/§4（两类成本）/§8（T0–T5）；`docs/baseline/2026-09-14-s5b-cpuprof-attribution.md`（点引 self 1.15%，证伪 Ⅱ）；S5b 计划 `docs/planning/phase2/S5b-hydration-projection-plan.md`。
- 向量（纯规划，无代码）：SPEC-enterprise `:52-53,87,103,123,136`；ARCH-enterprise §7（`:613-744`）、ADR 槽位 0016/0017（§10.4，尚无 ADR 文件）；PRD D-1/V1/V4。
