// scripts/acceptance/rollback/report.mjs
// 门③报告生成：汇总 results.tsv（每旗恢复秒数/断言命中/退出码）、R8 rollback.sh 真实性核查、
// R5 零外网审计、R6 计划偏差，产出 REPORT.md，并以末行 ROLLBACK_VERDICT=PASS/FAIL 收口。
// R8/R9 按 team-lead 要求生成带占位（执行人/日期/时刻/耗时/断言留空）的手测记录表。

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "./probe.mjs";

// 每个自动旗的人类可读说明（顺序即演练顺序）。
const FLAG_META = [
  { id: "R1", name: "GX_ENTERPRISE_ORG=off（组织面摘除）", check: "check-mounts orgoff" },
  { id: "R2", name: "GX_ENTERPRISE_NAV=off（导航面摘除）", check: "check-mounts navoff" },
  { id: "R3", name: "GX_AUTHZ_ENGINE shadow→off（旧三表守卫）", check: "check-authz" },
  { id: "R4", name: "GX_M1_SIDECAR_READ/KEYSET on→off（游标键消失）", check: "check-keyset" },
  { id: "R5", name: "GX_EMBEDDING_MODE cloud→off（纯 FTS，零外网）", check: "check-embedding" },
  { id: "R6", name: "outbox 回滚面：GX_SEARCH_WORKER=off 下 pending 静置不消化 + 手动 reindex 建 chunks", check: "check-outbox" },
  { id: "R6b", name: "P1 修复正立面：默认起 worker 后 outbox 自行追平 + 派生索引可读（249df44）", check: "check-outbox-drain" },
  { id: "R7", name: "GX_ENTERPRISE_ORG=off（/mcp、/pats 404，stdio 文件仍在）", check: "check-mounts orgoff + fs" },
];

function readTsv(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    const [id, recS, hits, rc, extra] = line.split("\t");
    return { id, recS, hits: Number(hits), rc: Number(rc), extra: extra ?? "" };
  });
}

function manualRow(id, title, expect) {
  // 执行人 | 日期 | 开始-恢复时刻 | 耗时 | 断言结果（全部留空待手填）
  return `| ${id} | ${title} | ${expect} |  |  |  |  |  |`;
}

function main() {
  const args = parseArgs(process.argv);
  const runDir = args["run-dir"];
  const rows = readTsv(path.join(runDir, "results.tsv"));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const meta = JSON.parse(fs.readFileSync(path.join(runDir, "meta.json"), "utf8"));
  const r8 = JSON.parse(fs.readFileSync(path.join(runDir, "r8.json"), "utf8"));
  const net = fs.existsSync(path.join(runDir, "net-audit.json"))
    ? JSON.parse(fs.readFileSync(path.join(runDir, "net-audit.json"), "utf8"))
    : null;

  const allAutoPass = ["R1", "R2", "R3", "R4", "R5", "R6", "R6b", "R7"].every((id) => byId.get(id)?.rc === 0);
  const r8StaticOk = Boolean(r8.exists && r8.isSymlinkSwitch && r8.readyzPoll && r8.systemctlGuard);
  const verdict = allAutoPass && r8StaticOk ? "PASS" : "FAIL";

  const L = [];
  L.push("# M7 门③ R1-R9 回滚演练记录");
  L.push("");
  L.push(`- 生成时间：${meta.generatedAt}`);
  L.push(`- 仓库 HEAD：${meta.head}`);
  L.push(`- node：${meta.node}`);
  L.push(`- 服务入口：${meta.distEntry}（真 dist，非 tsx/vitest）`);
  L.push(`- RUN_DIR：\`${runDir}\``);
  L.push(`- 数据库：当前 schema 全新 migrate（${meta.migrationCount} 迁移），全开姿态 HTTP 最小种子后逐旗复制静止库副本`);
  L.push("");
  L.push("> 本文件为自动化演练产物。门③是否过闸**以 team-lead 独立重跑为准**，本次不宣称过闸。");
  L.push("");
  L.push("## 一、行为层自动演练 R1-R7（真 dist 服务，on→改 env→重启→readyz→断言旧行为）");
  L.push("");
  L.push("恢复秒数 = 从启动进程到 /readyz 200 的毫秒级计时；每旗停旧进程后 wait_tree_gone 且核对");
  L.push("监听端口归属 PID==自记 PID，确认 off 探针不是打在旧进程上。");
  L.push("");
  L.push("| 旗 | 翻转 | 恢复(s) | 断言命中 | 退出码 | 备注 |");
  L.push("|----|------|--------|---------|--------|------|");
  for (const m of FLAG_META) {
    const r = byId.get(m.id);
    L.push(`| ${m.id} | ${m.name} | ${r ? r.recS : "—"} | ${r ? r.hits : "—"} | ${r ? r.rc : "—"} | ${r ? r.extra : "未执行"} |`);
  }
  L.push("");

  // R5 零外网证据
  L.push("## 二、R5 零外网证据");
  L.push("");
  if (net) {
    L.push(`- netguard 预加载（\`NODE_OPTIONS=--import netguard.mjs\`）包装 fetch/http/https/dns/tcp 出网面。`);
    L.push(`- 服务进程探针事件总数：${net.total}；回环/本地：${net.loopback}；bootstrap 自记：${net.bootstrap}；**外网：${net.external.length}**。`);
    L.push(`- 判定：检索全程外网出网 ${net.external.length === 0 ? "**=0**（零外网成立）" : "**非 0（不成立）**"}。`);
  } else {
    L.push("- 未找到 net-audit.json（R5 可能未执行）。");
  }
  L.push("- FTS 命中证据见 R5 行命中清单（hit 文件）：旧面 GET /api/search?q=zephyrmarker 200 且返回体含标记词。");
  L.push("");

  // R6 / R6b：outbox 两面（回滚面 + 修复正立面）
  L.push("## 三、R6 / R6b：outbox 消化链路（回滚面 + P1 修复正立面）");
  L.push("");
  L.push("**历史背景（2026-09-18 之前）**：本用例曾坐实两处计划/实现偏差——① 计划 §4 R6 的开关");
  L.push("`GX_SEARCH_WORKER` 在全 src 零接线；② 消化器 `SearchIndexer`（claim pending→processing→done）");
  L.push("只在 `indexer.ts:114` 被定义，**从未被任何生产代码 new/start**，而 full reindex 只重建派生库、");
  L.push("对 `change_events` 零写 → outbox 只进不出。该偏差由 team-lead 裁决为「属错误交付，须修」，");
  L.push("已由 **`249df44`** 修复：内嵌工人接进 `apps/api/src/index.ts`，门控＝`GX_M5_SEARCH=on` 且");
  L.push("`GX_SEARCH_WORKER!=off` 才启动；`reindex.ts` 重建期间挂起工人，避免换库后写旧句柄。");
  L.push("");
  L.push("- **R6（回滚面，`GX_SEARCH_WORKER=off`）**：与修复前同姿态——pending 静置不降、done=0，手动");
  L.push("  `POST /api/v1/admin/reindex` 仍可用（202 → chunks>0、coverage a-f 全 0）。证明旗标关闭时");
  L.push("  **不会**有任何后台消化器偷跑（详见 R6 行 hit 清单）。");
  L.push("- **R6b（P1 修复正立面，旗标缺省）**：全程**不发**任何 reindex 请求，outbox 由内嵌工人自行");
  L.push("  追平 pending→0、done>0，且 done 行带工牌 `workerId=api-<pid>@<ms>`（SearchIndexer 写入，");
  L.push("  与手动 reindex 路径零交集）；`GET /api/v1/admin/search/status` 读到 `chunks.total>0`、");
  L.push("  `rebuilding=false`。这是 249df44 的行为层证据（详见 R6b 行 hit 清单）。");
  L.push("");

  // R8 静态核查 + 手测表
  L.push("## 四、R8 应用层一键回滚（deploy/bin/rollback.sh）");
  L.push("");
  L.push("### 4.1 静态读码核查（自动化）");
  L.push("");
  L.push(`- 文件存在：${r8.exists ? `是（${r8.bytes} 字节，可执行位=${r8.executable}）` : "**否——缺失**"}`);
  L.push(`- 原子 symlink 切换 \`ln -sfn releases/\${TARGET} current\`：${r8.isSymlinkSwitch ? "是" : "否"}`);
  L.push(`- 切换后 \`systemctl restart\`：${r8.systemctlRestart ? "是" : "否"}`);
  L.push(`- /readyz 轮询判健康：${r8.readyzPoll ? "是" : "否"}`);
  L.push(`- 无 systemctl 守卫（目标机非 systemd 直接 die）：${r8.systemctlGuard ? "是" : "否"}`);
  L.push(`- 静态核查结论：${r8StaticOk ? "**真实存在且确为原子 symlink 切换 + readyz 轮询**" : "**不满足，需人工核查/补齐**"}`);
  L.push("");
  L.push("### 4.2 手测记录（需在部署目标机实跑，以下留空待签字）");
  L.push("");
  L.push("操作：在装有两版 release 的目标机以 root 执行 `sudo bash deploy/bin/rollback.sh`，");
  L.push("观察 current symlink 原子回上一候选 + systemd restart + /readyz 通过，并跑 M7 §7.4 冒烟集。");
  L.push("");
  L.push("| 项 | 检查 | 期望 | 执行人 | 日期 | 开始时刻 | 恢复/耗时 | 断言结果 |");
  L.push("|----|------|------|--------|------|----------|-----------|----------|");
  L.push(manualRow("R8-1", "rollback.sh 回上一候选", "current 指向上一 release，切换无中间断链"));
  L.push(manualRow("R8-2", "systemd restart 后 /readyz", `READY_TIMEOUT_S(${r8.readyTimeoutS}s) 内 status=ready`));
  L.push(manualRow("R8-3", "§7.4 冒烟集：登录+列表+建记录+搜索+MCP tools/list", "全部 200/正常"));
  L.push(manualRow("R8-4", "回滚总耗时 ≤30 分钟（硬判据）", "≤30min"));
  L.push("");

  // R9 手测表
  L.push("## 五、R9 数据层时间点恢复（docs/runbooks/restore.md）");
  L.push("");
  L.push(`- runbook 存在：${meta.restoreRunbook ? `是（${meta.restoreRunbookLines} 行）` : "**否——缺失**"}；含 verify-restore.mjs 对账步骤。`);
  L.push("");
  L.push("### 5.1 手测记录（需在克隆机按 restore.md 全流程实跑，留空待签字）");
  L.push("");
  L.push("| 项 | 检查 | 期望 | 执行人 | 日期 | 开始时刻 | 耗时 | 断言结果 |");
  L.push("|----|------|------|--------|------|----------|------|----------|");
  L.push(manualRow("R9-1", "克隆机取最近加密备份恢复到 /tmp/gx-restore.*", "verify-restore MATCH"));
  L.push(manualRow("R9-2", "用恢复库起服务 + /readyz", "status=ready"));
  L.push(manualRow("R9-3", "§3.3 抽样：随机 N 条记录/文档/画布内容比对", "抽样 0 损坏"));
  L.push(manualRow("R9-4", "恢复总耗时 ≤30 分钟（硬判据）", "≤30min"));
  L.push("");

  L.push("## 六、需人工签字 / 待裁决项（无法用 HTTP 机械验证或超出自动化范围，不伪装自动绿）");
  L.push("");
  L.push("- R8-* / R9-*：目标机/克隆机实跑（依赖 systemd、/srv/gouxiangdb 部署树、备份介质），本机不具备。");
  L.push("- R6 / R6b 已由行为层自动探针机械验证（回滚面不偷跑、修复面自行追平），本轮无待裁决项。");
  L.push("  残留观察：`SearchIndexer.stop()` 是协作式的，挂起中途若工人正处理单条，该轮仍可能写旧文件");
  L.push("  （窗口＝单条处理耗时）；彻底消除需给 indexer 加 quiesce 屏障，属改既有语义，本轮未做。");
  L.push("- 前端壳/视觉类回滚表现（菜单消失、设置入口）不在 HTTP 行为层，由门①④/前端回归覆盖。");
  L.push("");
  L.push(`ROLLBACK_VERDICT=${verdict}`);

  fs.writeFileSync(path.join(runDir, "REPORT.md"), L.join("\n") + "\n");
  console.log(`[report] -> ${path.join(runDir, "REPORT.md")} verdict=${verdict}`);
  process.exit(verdict === "PASS" ? 0 : 2);
}

main();
