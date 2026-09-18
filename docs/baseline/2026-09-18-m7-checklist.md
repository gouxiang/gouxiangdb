# M7 企业版总验收 — 逐条可勾 checklist（门⑦）

- 日期：2026-09-18
- 作者：research-m7-checklist（只读核查 + 纯文档；**不写生产码、不改测试、不代跑任何门**）
- 基线：`main` @ `83bf3ef`（写作时 HEAD）
- 条目来源：`docs/planning/phase2/M7-implementation-plan.md` §2（门①）／§3（门②）／§4（门③）／§5（门④）／§6（门⑤）／§7（门⑥）／§8（门⑦ checklist 本体）／§10（门⑧ 判据）
  - 该计划写于较早时间点，**部分行号、ADR 编号、迁移数已过期**；本表一律以**仓库现状**为准，过期处已在「备注」列显式标注。

---

## 0. 判定口径（先读这个）

| 判定 | 含义 | 硬性要求 |
|---|---|---|
| **过** | 有可指认的硬证据 | 必须是下列之一：① commit hash（本人 `git log -1` 核过）；② `docs/baseline/*` 里某份已登记的实跑数字（本人打开该文档核过）；③ `/tmp/gx-*` 演练产物路径（本人列目录/读报告核过） |
| **不过** | 有证据表明未达判据 | 需给出实测数字或明确"未实测/全空"证据 |
| **未做** | 查不到任何证据 | **"脚本存在""文档存在""测试存在"一律不算证据**——存在 ≠ 跑过 |
| **待签字** | 证据部分存在，但仍需人工/总监签字确认 | 手测矩阵、总监决策项、跨形态未覆盖项 |

**纪律声明**：本表不复制其它文档的结论而不核对。凡引用数字，均打开源文档或 commit 确认其真实存在；核不到的写「未做」。本表共 **86 条**。

---

## 1. 门① 五主线端到端对抗回归（AC-M2 ~ AC-M6）

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-①-01 | 47 条对外 AC 全部有真实会执行的自动化归属，零"找不到文件" | 过 | `f5fb7bc` 台账 §0（39 条全自动闭环 + 8 条自动+签字，无纯手测 AC） | — |
| M7-①-02 | 定向实跑坐绿：193 文件 / **2028 passed** / 0 fail | 过 | `f5fb7bc` 台账 §0（api 159 文件 1597 + e2e 6/64 + web 23/278 + shared-types 56 + canvas 33） | 定向分批实跑，**不等于全量一次跑**（见 ④-08） |
| M7-①-03 | M4 规模门 `GX_M4_GATE=1` 真跑 | 过 | `f5fb7bc` 台账 A.3 M4-10：scope-scale + s10-scale-gate **10/10** | 该门默认 skip，需显式开 |
| M7-①-04 | M2 9 条 / M3 10 条 / M4 10 条 / M5 9 条 / M6 9 条逐条有自动化并实跑 | 过 | `f5fb7bc` 台账 A.1–A.5 逐行"实跑"列 | — |
| M7-①-05 | 缺口 C-1/C-2/C-5 补码关闭 | 过 | `528ecee`（C-2 菜单快捷项权威 parentId + C-1 p95 门控阈值）、`55f5213`（C-5 isSafeUrlAttr 36 数据点） | — |
| M7-①-06 | 缺口 C-3/C-4/C-6/C-7/C-8/C-9 按裁决登记处置 | 过 | `f5fb7bc` 台账 §C.0（逐条裁决 + 落地位置） | 本行只判"已裁决并登记"，**不判"门已过"**；C-7 归 ⑤-09 |
| M7-①-07 | 手测签字项（台账 §D 十组）带日期+执行人 | **未做** | `f5fb7bc` 台账 §D 十条均为"待签字"描述，无执行人/日期 | 含 RC-13~25、RC-03/05/06/36/39/40、RC-27、M6-3a/3b 目检 |
| M7-①-08 | Playwright `canvas-mcp-golden.spec.ts` 实跑（chromium+webkit） | **未做** | `f5fb7bc` 台账 §D-9 明写"本轮未起长服务，门时执行" | 需 `scripts/dev-up.sh` 起 :3001+:5173 |

---

## 2. 门② AC-UPG-1 v0.1.0 → M7 直升抽样零损坏

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-②-01 | 直线 `prisma migrate deploy` 全程 19 步 exit 0、`DRILL_VERDICT=PASS` | 过 | `/tmp/gx-lead-rerun5/REPORT.md`（`DRILL_VERDICT=PASS`、damageCount=0）+ `steps.tsv` 全 19 行退出码 0 | — |
| M7-②-02 | 零损坏独立复算：15 组实体 idSet/count 零失配、500 records 字段 JSON 0 diff、26 kb_docs 逐字节 0 diff、contentVersion 0 递增 | 过 | `/tmp/gx-lead-rerun5/REPORT.md`：`verdict=PASS，damageCount=0` | 由总监独立重算，不采信脚本自判 |
| M7-②-03 | B5 自举 applied=23（期望 23）/ rolled_back=0 | 过 | `/tmp/gx-lead-rerun5/steps.tsv` 行 `6d-check-bootstrap 0`（REPORT.md:25） | — |
| M7-②-04 | 黄金 12/12 + LCG 独立对拍 24/24 | 过 | `steps.tsv` 行 `7a-verify-golden 0`（REPORT.md:48 LCG 24/24） | — |
| M7-②-05 | 旧分享链接 13/13 可开 + 越界 403 | 过 | `steps.tsv` 行 `7b-check-share-links 0` | — |
| M7-②-06 | search FTS-only（chunks=5528、coverage 全 0、零外网）+ 删库自愈 | 过 | `steps.tsv` 行 `8-check-search 0` | — |
| M7-②-07 | body 七档边界全过 | 过 | `steps.tsv` 行 `9-check-body-limits 0` | — |
| M7-②-08 | 部署链路 nav path 重算接线（§3.1 硬前置） | 过 | `steps.tsv` 行 `5-check-nav-paths 0 1138`；产物集成测试 `40ae7c3`（exit64/首跑 pathsRebuilt/二次 no changes） | — |
| M7-②-09 | 二次 `migrate deploy` 幂等（applied 跳过、行数零增长） | 过 | `docs/baseline/gate6-evidence/2026-09-18-docker-arm64-smoke.md` 格 2：`重启后 "No pending migrations to apply"，applied 恒 23`（`072930a`） | 门② steps.tsv 未单列幂等步，此处以 Docker 形态重启幂等为证 |
| M7-②-10 | 人工目检段签字（RC13~RC25 Web 手测） | **未做** | `scripts/acceptance/R8-manual-checklist.md` 实读：13 行的「结果/验收人/日期」三列**全部留空** | 计划 §3.3 判据要求"diff-snapshot exit 0 **且人工目检段全部签字**"，后半截未满足 |
| M7-②-11 | 在**最终候选构建**上重跑一次（含 `249df44` 及之后提交） | **未做** | `/tmp/gx-lead-rerun5/REPORT.md:6` 自记候选 HEAD `55f5213`；生产码修复 `249df44`（接线内嵌索引 worker，改 `apps/api/src/index.ts`）在其之后 | 现有门②证据不覆盖 HEAD `83bf3ef` |

---

## 3. 门③ 回滚演练（flag off 矩阵 + 30 分钟计时）

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-③-01 | R1~R7 行为层真 dist 实演并计时，判据 ≤30 分钟 | 过 | `/tmp/gx-rb-lead-r6b-1789704671/results.tsv`：R1 0.571 / R2 0.571 / R3 0.552 / R4 0.578 / R5 0.585 / R6 0.574 / R7 0.587 秒，全 exit 0 | 远低于 30 分钟判据 |
| M7-③-02 | R5 零外网（netguard 自检先过才允许判绿） | 过 | `/tmp/gx-rb-lead-r6b-1789704671/REPORT.md` §二：外网出网计数 **0** | — |
| M7-③-03 | R6 回滚面：`GX_SEARCH_WORKER=off` 时 pending 静置不降、done=0、手动 reindex 仍可用 | 过 | `results.tsv` R6 行；拆面提交 `63fbe71` | — |
| M7-③-04 | **R6b P1 修复正立面**：不发 reindex 请求，outbox 自行 pending 4→0 / done 0→4、工牌 `workerId=api-<pid>@<ms>` | 过 | `/tmp/gx-rb-lead-r6b-1789704671/results.tsv` R6b 行；修复 `249df44`；两面设计 `63fbe71` | `report.mjs` 已把 R6b 纳入 `allAutoPass`，缺失即 FAIL |
| M7-③-05 | R7 `/mcp`、`/api/v1/pats` 404 且 `dist/mcp-stdio.js` 文件仍在 | 过 | `results.tsv` R7 行（hits=7 + 文件存在 1） | — |
| M7-③-06 | **R8 应用层一键回滚**（rollback.sh 原子 symlink 切换 + readyz）实跑并计时 ≤30 分钟 | **未做** | `/tmp/gx-rb-lead-r6b-1789704671/REPORT.md` §4.2：R8-1~R8-4 四行「执行人/日期/耗时/断言结果」**全部留空**；§4.1 只有 `check-r8-static.mjs` **静态读码**（文件存在性 + symlink 写法），非实跑 | 计划 §10.2 判据 3 要求 R1~**R8** ≤30 分钟 |
| M7-③-07 | **R9 数据层快照恢复**（克隆机 restore.md 全流程）实跑并计时 ≤30 分钟 | **未做** | 同上 REPORT.md §5.1：R9-1~R9-4 四行**全部留空**；仅确认 `docs/runbooks/restore.md` 存在（119 行） | 门③ 的 `ROLLBACK_VERDICT=PASS` 由 `report.mjs` 只统计 R1–R7+R6b 得出，**不含 R8/R9** |

---

## 4. 门④ RC-40 + 新增对抗用例总台账

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-④-01 | RC-01~40：20 条有自动化并实跑绿（18 全自动 + RC-02/26 半自动） | 过 | `f5fb7bc` 台账 §B.1 逐行实跑列 | 其余 20 条为 RC 文档自标【UI】/【手册】 |
| M7-④-02 | RC-41~55（G 导航组 / H 权限组 15 条）全自动化并实跑 | 过 | `f5fb7bc` 台账 §B.2 | — |
| M7-④-03 | 本轮补测 rc09/10/11/12/35 入仓并绿 | 过 | `506848f`；台账 §B.1 RC-09/10/11/12/35 行 | — |
| M7-④-04 | 各里程碑新增对抗组（M2/M3/M4/M5/M6 + M7 新增脚本）全在仓并实跑 | 过 | `f5fb7bc` 台账 §B.3；`0d0692b`（scripts/acceptance 入仓） | 台账 §5.2 判据"不允许出现未执行/未找到文件行" |
| M7-④-05 | 台账无"未执行 / 未找到文件"行 | 过 | `f5fb7bc` 台账 §0 + §C.0 门④结论 | — |
| M7-④-06 | 手测类 RC 逐项签字（画布 RC-13~25、RC-03/05/06/36/39/40、RC-27） | **未做** | `f5fb7bc` 台账 §D 第 1/2/3/5 组，无日期/执行人 | 与 ①-07 同源 |
| M7-④-07 | CI 一次跑全绿：`bash scripts/ci-quality.sh` 八步 | **未做** | `scripts/ci-quality.sh:1-112` 存在（八步：版本/冻结安装/generate/typecheck/build/test/lint/迁移干跑），但**查无 M7 门时全量绿运行日志**；台账 §B.1 RC-38 行仍写"门时 team-lead 独占机跑" | 脚本存在 ≠ 跑过 |
| M7-④-08 | `NODE_ENV=test pnpm -w test` 全量一次过，实数分列回填 | **未做** | 总验收报告 §7 唯一一轮：**1 failed / 194 passed / 3 skipped；Tests 2127 passed / 28 skipped**，且该轮**早于 `249df44`**；重跑在途（task #347） | 失败项已由 `11c4dc8` 给 30s 预算，但复跑未出结果前不留"过" |

---

## 5. 门⑤ 性能门证据汇总

权威登记：`docs/baseline/2026-09-18-m7-gate5-performance.md`（22 条证据 / 10 条缺口）。

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-⑤-01 | 性能证据汇总三要素（机器 / 测法样本量 / 阈值结论）登记齐 | 过 | `docs/baseline/2026-09-18-m7-gate5-performance.md` §0–§2（`eee56b9`） | — |
| M7-⑤-02 | 通讯录 500 成员三接口 P95（门 p95<150ms） | 过 | E-06/E-07：`GX_PERF_GATE=1` warmP95 **2.22 / 0.67 / 0.44 ms**（`528ecee`） | 【M-B】内部留档，不得进对外材料 |
| M7-⑤-03 | 组织求值定数 SQL（无 N+1） | 过 | E-08：`effectiveRoleRows` ≤3、`listMembers` 恒 4 | 计数口径＝Prisma 模型委托往返 |
| M7-⑤-04 | M4 规模门 P95 + EXPLAIN + 12000 次零分叉 | 过 | E-12：decide P95 0.36–0.41ms、scope P95 41.8–44.0ms；E-13：SQL ≤4、EXPLAIN 全走索引、12000 次 0 差异 | 机器规格未逐项登记（G-10） |
| M7-⑤-05 | MCP 超时机制 + 限流可观测 | 过 | E-20（1200ms 档实测 1284ms 返 TIMEOUT，连接未挂）、E-21（第 4 次 429 + Retry-After: 60） | G-07（默认 30s 档未端到端实证）、G-08（限流不拦正常流无实测）另计 |
| M7-⑤-06 | M1 物理索引层 / T0 连接层（50 万行、C=8） | 过 | E-01（0.386–12.153ms，无裸 SCAN）、E-02（3601 采样 failures=0，T0 三条件全过） | 同轮 7 条 T3 场景 P95 breach，归 #89/S5b 后（G-04） |
| M7-⑤-07 | 检索门：10 万 chunk hybrid P95<500ms（Tier-L 双真机十轮） | **不过** | E-14【M-A】：hybrid p95 1k≈20.6ms（过）/ **10k≈646.2ms / 100k≈14,571ms（未过）**；fts-only 100k≈3,670ms | 落在计划 §10.2 已预批的 B-5 降级路径，**不阻塞 M7** |
| M7-⑤-08 | Tier-L **arm64** 真机性能数字 | **未做** | E-16 / G-01：仅 CI 交叉构建冒烟，性能零实测 | 对外**不得出现 arm 性能数字** |
| M7-⑤-09 | SPEC:134「500 成员 / 10 万节点首屏 <1s」 | **未做** | E-09 / G-02：计划指定证据位 `docs/baseline/2026-09-16-m3-gate.md` **不存在**（`ls docs/baseline` 实查）；`reconcile-scale` 仅 1k/1w 且无时延断言；task #158 pending | 按**限定值**登记，阻断"10 万节点"承诺口径 |
| M7-⑤-10 | M1 keyset/sidecar 读路径 shadow 集成等价证据 | **未做** | E-05 / G-05：task #103 pending、#106 in_progress、#110 pending | 门⑧「M1 读路径姿态」签字的前置，无证据则不能签 on |
| M7-⑤-11 | 缺口 G-03/G-04/G-07/G-08/G-09/G-10 如实登记（不补编、不插值） | 过 | gate5 §2 逐条标注"未做/未过" | 本行判"已如实登记"，**不判"门槛已过"** |
| M7-⑤-12 | 门⑤ 完整过闸（有条件过 → 无条件） | **待签字** | gate5 §3-6：还欠四项签字中的「Tier-L 措辞」与「M1 读路径姿态」 | 签字未齐前只能登记"有条件过" |

---

## 6. 门⑥ 三环境部署物与冒烟（计划 §7）

> **纪律提示**：计划要求的 consolidated 门⑥ 文档 `docs/baseline/2026-09-18-m7-gate6-deploy-smoke.md` **不存在**（`ls docs/baseline/` 实查无此文件）。按门⑦纪律，门⑥整门登记为「未做」，**本表不代补该文档**；下表中标「过」的行只表示**该格有独立证据文件**，不等于门⑥过闸。

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-⑥-00 | 门⑥ consolidated 冒烟文档（含 TODO/未做矩阵） | **未做** | `docs/baseline/2026-09-18-m7-gate6-deploy-smoke.md` 不存在 | 总验收报告 §6 仍标"未执行" |
| M7-⑥-01 | Docker **arm64** 冒烟：格 1/2/3/4a/4b/5/6-R1/8 + 子路径 + 迁移 23 | 过 | `docs/baseline/gate6-evidence/2026-09-18-docker-arm64-smoke.md`（`072930a`）；镜像 `sha256:378fc41fbcb9`，37/37 步 | 逐格 PASS，8/8、3/3、7/7 |
| M7-⑥-02 | 裸机 tar **macOS arm64** 直跑：格 1/3/4a/4b/5-7 + vec0 darwin + SIGTERM 优雅关闭 | 过 | `docs/baseline/gate6-evidence/2026-09-18-baremetal-tar-arm64-smoke.md`（`072930a`）；checksums 4163 文件 `shasum -a 256 -c` **0 失败** | 与 Docker arm64 逐格一致 |
| M7-⑥-03 | 封版产物基于 `11c4dc8` 重验（P1 worker 修复：默认 off 休眠零副作用 / on 产品级 1s 追平） | 过 | `docs/baseline/gate6-evidence/2026-09-18-docker-arm64-smoke.md` §封版补记（`a23a68c`）；`gouxiangdb:m7-final`、tar `20260918040846` | 非单测、真 dist 双实例 |
| M7-⑥-04 | **飞牛 fpk** 冒烟（x86 + arm 真机） | **未做** | 两份证据 §未实测 均标"目标机不可达" | 计划 §7.2 要求至少一台 x86 飞牛 |
| M7-⑥-05 | **amd64 镜像 / buildx 双架构** | **未做** | docker 证据 §未实测："本机无 buildx、单 arm64 原生" | 计划 §7.3 要求双架构各跑一遍 |
| M7-⑥-06 | **Caddy 真机反代 + /mcp**（11m client_body） | **未做** | docker 证据 §未实测："docker.io 不可达，拉不到 caddy 镜像"；仅 Caddyfile 静态审计（:21 /mcp matcher、:37-39 12MB） | 直连 11MB 档已实测，反代一跳待目标机签字 |
| M7-⑥-07 | **Linux x86 裸机直跑** + `deploy.sh`/`rollback.sh` systemd 真机 | **未做** | tar 证据 §未实测："无 x86 目标机" | 与 ③-06 R8 同源 |
| M7-⑥-08 | **macOS 旧 Tauri 桌面端**连新服务端升级提示、不白屏（SPEC:133） | **未做** | tar 证据 §未实测："需桌面 UI 手测" | — |
| M7-⑥-09 | 三环境冒烟矩阵**逐格**过（计划 §10.2 判据 5） | **不过** | ⑥-04~⑥-08 五格在证据文件中显式标【未实测】 | 飞牛/arm 为外部依赖；在无可用降级路径前判据 5 不满足 |

---

## 7. 门⑦ checklist 本体（计划 §8.1–§8.4）

### 7.1 代码与质量（§8.1）

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-⑦-01 | `pnpm -w install --frozen-lockfile` 干净 + `bash scripts/ci-quality.sh` 绿 | **未做** | 见 ④-07；无门时运行产物 | — |
| M7-⑦-02 | 全量测试一次过、实数分列回填、skipped 原因逐条 | **未做** | 见 ④-08 | — |
| M7-⑦-03 | openapi.yaml 与实现对拍 0 diff | 过 | 台账 A.3 M3-10：`docs/openapi-contract(19)` + `s8-openapi-shapes(12)` + `s9-dto-cross(8)` 实跑绿（`f5fb7bc`）；`docs/api/openapi.yaml` 100040 字节在库 | — |
| M7-⑦-04 | 错误码词汇表齐（`UNSUPPORTED_OPERATION`、`PAT_EXPIRY_INVALID`） | 过 | `docs/api/openapi.yaml` 实查：`UNSUPPORTED_OPERATION` 2 处、`PAT_EXPIRY_INVALID` 4 处 | — |
| M7-⑦-05 | ADR 归档齐，状态字段无"越权 Accepted" | 过 | `docs/adr/` 实查 28 篇（0022-0025、0032-0055）状态行均带裁决/落地依据与日期；`0009` 仍 `Proposed / 占位`（非越权）；ADR-0008 状态行已由总监终检后置 Accepted 并**显式限定覆盖范围** | **计划 §8.1 写的 0026/0027/0041-0049/0050-0054 编号已过期**，实际编号区间见左 |
| M7-⑦-06 | 全仓 P0 设计纪律扫描（emoji 充图标 / icons.tsx 单一 SVG 体系 / 紫粉渐变 / 裸 `z-[n]` / 硬编码色值） | **未做** | `scripts/` 实查无扫描脚本（仅 acceptance/ci-quality.sh/compare-test.sh/dev-up.sh/refresh-progress-data.mjs/smoke_defaults.py）；`ci-quality.sh:40-111` 八步无此项 | 需人工双检并留证 |
| M7-⑦-07 | 方言巡检：企业版迁移无 SQLite 专有写死（SPEC:60），白名单逐处注释 | **未做** | 无巡检证据文档。本人 spot grep 已见：`20260913062000_record_field_index_sidecar/migration.sql:16` `INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT`，及 init/`add_doc_tree_and_share` 中 Prisma 生成的 `PRAGMA defer_foreign_keys/foreign_keys` 样板 | 未做白名单逐处注释归档，**不留"过"** |
| M7-⑦-08 | 旧 /api 与旧页面字节零 diff（各 S0 golden 汇总） | 过 | 台账 A.6：characterization 5 件 + org 3 件 + `m5-search-golden`+snapshot + `m6-s0-characterization` + `search-bounds` + `records-keyset(7)` + `keyset-flags(8)` = **9 文件 111 passed**（`f5fb7bc`） | — |

### 7.2 安全（§8.2）

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-⑦-09 | AC-M6-1/2/4 与 M4 越权矩阵全绿 | 过 | 台账 A.5（M6-1/2/4）、A.3（M4-6）；P0-A `ab5b956`、P1-B `277fd95`+`63020ea` 实跑绿 | — |
| M7-⑦-10 | IDOR 零泄漏（四族） | 过 | 台账 A.5 M6-2：`e2e/m6-s8-idor(9)` | — |
| M7-⑦-11 | 审计四事件 + 参数脱敏无业务值 | 过 | 台账 A.5 M6-4：`m6-s7-audit-idempotency(12)`；`e2e/m6-s8-401:113` 审计无 token | — |
| M7-⑦-12 | PAT 明文全产物 grep（日志/库/产物零完整 token） | **待签字** | Docker 形态已查：`/data` 与 stdout 明文零命中、镜像 ENV 无 `JWT_SECRET`、库存 tokenPrefix(14)+tokenHash(sha256,64)（`072930a`） | tar/fpk 形态未做；台账 §D-10 仍列"待做" |
| M7-⑦-13 | 备份：发布前在线快照成功 | 过 | `/tmp/gx-lead-rerun5/steps.tsv`：`3c-online-backup 0`、`3d-verify-restore 0` | 演练内成功，非生产环境 |
| M7-⑦-14 | age 异地加密策略（默认不激活，PLAN-ADJUST 口径）按客户合同 | **待签字** | 无 M7 门时证据文档；`docs/adr/0010-offsite-age-encryption.md` 在库 | 姿态需总监/客户确认 |
| M7-⑦-15 | restore 演练（R9）在克隆机过 | **未做** | 见 ③-07（R9-1~R9-4 全空） | — |
| M7-⑦-16 | 密钥：`JWT_SECRET` 非默认 | **待签字** | Docker 证据仅"镜像 ENV 无 JWT_SECRET"；生产部署实际取值无留证 | 启动闸门存在不等于生产值已核 |
| M7-⑦-17 | embedding key 加密落库仅 maskedLast4；**600 权限位核查** | **未做** | 无 M7 门时 600 位核查产物；台账 A.5 M5-7 覆盖"只回 configured/maskedLast4"（密钥部分） | 600 位部分缺证 |

### 7.3 文档与交接（§8.3）

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-⑦-18 | runbooks 增章齐（M2 四章 / M3 reconcile+新壳回退 / M4 五章 / M5 五章 / M6 章节）+ README 索引 | **待签字** | `git ls-files docs/runbooks/` 实查 13 份在库（README/authz×3/backup/ci/deploy/m1-sidecar/m5-search/mcp/org-contacts/restore/wal-crash-recovery） | **无逐章对账证据**；"M3 新壳回退"章 grep 未见（`docs/runbooks/` 仅 mcp.md/authz-policy-dual-write.md 提 `GX_ENTERPRISE_NAV`） |
| M7-⑦-19 | 《MCP 客户端接入说明》协议无关版齐备 | 过 | `docs/guides/mcp-client-onboarding.md` 已 `git ls-files` 入库 | 协议无关性未逐句复核 |
| M7-⑦-20 | RELEASE.md 发布说明（版本号/迁移数/§4.1 flag 姿态矩阵/降级姿态/§9 已知不做项/桌面端兼容提示） | **未做** | 仓内 `RELEASE.md` 实读为 **2026-09-04 单次迭代自测报告**，文件头自带"历史档案声明，不是当前部署/配置依据" | M7 发布说明尚未产出，不是"已交付" |
| M7-⑦-21 | 三份产物 checksums **签字** | **待签字** | tar checksums 4163 文件 `shasum -a 256 -c` 0 失败（`072930a`）；fpk 无产物 | "签字"栏未签；三份不齐（缺 fpk） |
| M7-⑦-22 | fpk / Docker 镜像 digest 入报告 | **未做** | Docker 镜像 ID 有（`sha256:378fc41fbcb9`），但总验收报告 §6 仍标"未执行"，未入报告；fpk 无 digest | — |

### 7.4 决策签字（§8.4）——四项均未签

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-⑦-23 | `GX_AUTHZ_ENGINE` 发布值（shadow / off），总监**明确下令并记录** | **待签字** | 总验收报告 §7 明写"四项总监签字均未签" | 计划 §8.4：不许现场默认 |
| M7-⑦-24 | `GX_EMBEDDING_MODE` 发布值（默认 off；cloud 高配单独交付） | **待签字** | 同上 | 与 ⑤-07 降级路径联动 |
| M7-⑦-25 | Tier-L 真机门结果（过/未执行/不过）与对应对外措辞，总监+主理人知悉 | **待签字** | 同上；真机结论见 ⑤-07/⑤-08 | — |
| M7-⑦-26 | M1 读路径姿态（on with 双零证据 / 明确 off 发布） | **待签字** | 同上；前置证据 ⑤-10 未做，目前**不具备签 on 的条件** | — |

---

## 8. 门⑧ 总验收报告与通过判据（计划 §10）

| # | 内容 | 判定 | 证据 | 备注 |
|---|---|---|---|---|
| M7-⑧-01 | 总验收报告存在并逐门如实登记 | 过 | `docs/baseline/2026-09-18-m7-acceptance-report.md`（`6756249` 起，HEAD `83bf3ef`） | — |
| M7-⑧-02 | 报告模板九节齐全 | 过 | 实查 §1 五主线 / §2 直升 / §3 回滚 / §4 台账 / §5 性能 / §6 部署 / §7 姿态签字 / §8 缺陷 / §9 结论 | — |
| M7-⑧-03 | 判据「通过」 | **不过** | 报告 §9：判据 5（三环境冒烟逐格）、6（安全扫描零阻断）、7（四项签字）不满足 → **尚未通过** | 判据 1/2/3/4 侧：①②③④ 已过闸（③ 含总监独立重跑） |
| M7-⑧-04 | 缺陷清单挂账项均有 backlog 链接 | **待签字** | 报告 §8：C-7 有 task #158；但"富文本内联 `data:` 图片被拦（P2）"只写"待产品决策"，**无 backlog 链接** | 计划 §10.1 要求挂账须有 backlog 链接 |

---

## 9. 汇总计数（86 条）

| 判定 | 条数 | 分布 |
|---|---|---|
| **过** | **46** | 门① 6、门② 9、门③ 5、门④ 5、门⑤ 7、门⑥ 3、门⑦ 9、门⑧ 2 |
| **不过** | **3** | ⑤-07（检索门未达线）、⑥-09（三环境矩阵未逐格）、⑧-03（判据"通过"不满足） |
| **未做** | **26** | 门① 2、门② 2、门③ 2、门④ 3、门⑤ 3、门⑥ 6、门⑦ 8、门⑧ 0 |
| **待签字** | **11** | 门⑤ 1、门⑦ 9、门⑧ 1 |
| 合计 | **86** | — |

---

## 10. 最容易被误写成「过」、本表坚持写「未做」的三条

1. **M7-③-06 R8 代码回滚 / M7-③-07 R9 快照恢复** —— 门③ 的 `ROLLBACK_VERDICT=PASS` 很容易被当成"R1~R9 全过"。实读 `/tmp/gx-rb-lead-r6b-1789704671/REPORT.md`：R8-1~R8-4 与 R9-1~R9-4 两张表**八行全部留空**；R8 只有 `check-r8-static.mjs` 的**静态读码**（证明文件存在 + symlink 写法正确），R9 只确认 `restore.md` 存在 119 行。`report.mjs` 的 `allAutoPass` 只统计 R1–R7 + R6b，因此 PASS 不含 R8/R9。计划 §10.2 判据 3 明确要求 **R1~R8** ≤30 分钟且 **R9** 克隆机恢复成功 —— 判据未覆盖，**未做**。

2. **M7-②-10 门② 人工目检段签字** —— 计划 §3.3 判据是"diff-snapshot exit 0 **且人工目检段全部签字**"。脚本侧 19 步全 0、`damageCount=0` 属实（`/tmp/gx-lead-rerun5`），但 `scripts/acceptance/R8-manual-checklist.md` 里 RC13~RC25 十三行的「结果 / 验收人 / 日期」**三列全空**，门② REPORT.md:81 亦自注"见 R8-manual-checklist.md 人工签字"。脚本绿 ≠ 目检签完，**未做**。

3. **M7-⑦-07 方言巡检** —— 极易被写成"迁移跑通即合规"。计划 §8.1 要求的是"全部企业版迁移无 SQLite 专有写死 + **白名单逐处注释**"。本仓确实存在 SQLite 专有写法（`20260913062000_record_field_index_sidecar/migration.sql:16` 的 `INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT`，以及 Prisma 生成的 `PRAGMA defer_foreign_keys/foreign_keys` 样板），且**没有任何白名单注释/巡检证据文档**。跑通 ≠ 巡检完成，**未做**。

> 另附一条次高危（同样易被误判，虽不在上述三条内）：**M7-⑦-20 RELEASE.md** —— 仓内确有 `RELEASE.md`，但它自带头部的"历史档案声明"，是 2026-09-04 的自测记录，不是 M7 发布说明。按"存在 ≠ 交付"判 **未做**。

---

## 11. 本表边界

- 本表为**纯文档**：不跑门、不改生产码、不改测试、不代补门⑥ 冒烟文档。
- 所有"过"行的证据均可被他人 `git log -1 <hash>` / 打开对应 baseline 文档 / 列 `/tmp/gx-*` 目录复核。
- 与源文档冲突时以源文档为准；源文档缺失或无留证的，一律落「未做」，不得以同量级外推或"脚本存在"补判。
