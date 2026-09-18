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

## 5. 性能（门⑤）— **未汇总**

- 已知留档（开发机，内部）：通讯录 500 成员三接口 warm p95 2.22/0.67/0.44ms（门控阈值 150ms）；M5 主写 P95 `toBeLessThan(150)`；M4 规模门 P95 上界；Tier-L x86 单真机 100k hybrid p95≈14.6s（**未达 500ms 线**）
- **Tier-L arm64 真机未做**；按 §6.2 降级姿态：`GX_EMBEDDING_MODE=off` + FTS 默认发布，cloud 作高配能力，对外材料禁写该承诺
- **C-7**：SPEC:134「10 万节点首屏<1s」无门证据文档（`2026-09-16-m3-gate.md` 不存在，task#158 pending），按**限定值**登记，不补编

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

## 9. 结论

**尚未通过** —— 门②过闸、门①/④台账成稿且缺口已裁决关闭，但门③/⑤/⑥/⑦ 未执行，门⑧四项签字未签。
判据（§10.2）中第 3/5/7 条不满足，故当前只能登记为"进行中"，不构成放行。
剩余阻塞：**门③脚本与独立重跑**、**全量门独占跑**（需空闲机或 VM `192.168.31.15` 凭证）、**三环境冒烟**（飞牛/arm 为外部依赖）。
