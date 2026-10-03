#!/usr/bin/env node
// apps/api/scripts/authz/preflight.ts
// 【通电前体检】唯一入口：一次回答「这个库现在能不能安全通电」。
//
// 用法（cwd=apps/api）：
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/preflight.ts          # 人读报告；READY exit 0 / NOT_READY exit 1
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/preflight.ts --json    # 机器读
//
// 逐项输出：
//   1 覆盖：role_library_scope 行数 / 涉及角色 / auth_policies 里 reason='scope:role' 行数 / 期望-现存缺口；
//   2 对账：reconcile A/B/C/S 四段（按码聚合，标阻断或提示）；
//   3 库级聚合位等价性（ADR-0056 §10.1）：抽样比对 base 节点的 enter/edit_data 与
//      legacy access.visible / perm.canEditData 是否逐值相等——不等价即阻断；
//   4 库节点是否在 S4 可见集里：表可见而库不可见 -> 通电后库整层从导航/检索消失；
//   5 legacy 残留：说明现状，不自动删；
//   6 双写接线：静态扫描 apps/api/src（不含 __tests__）的钩子调用点，不靠记忆；
//   7 门：AUTHZ_ENFORCE_READY 常量（只读，不翻门）。
//
// 退出码与 scripts/authz/reconcile-policies.ts 同口径：0=READY，1=NOT_READY，64=用法错。

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { resolveDatabaseFile } from "../../src/db/databaseFile.js";
import { AUTHZ_ENFORCE_READY } from "../../src/configAuthz.js";
import {
  computePreflightData,
  evaluatePreflight,
  type PreflightFacts,
  type PreflightReport,
} from "../../src/domain/authz/preflight.js";

/** 交互事务超时：大库逐库 loadLiveShape 会超过 Prisma 默认 5s，显式放宽。 */
const TX_OPTS = { timeout: 120_000, maxWait: 30_000 } as const;

/**
 * 双写钩子：required=true 的是主路径（缺了会导致通电后新写的权限不再投影 -> 阻断）；
 * required=false 的是结构性钩子（建/删表级联、字段变更重算 mask，缺了只在结构变更时漂移 -> 提示）。
 */
const HOOKS: ReadonlyArray<{ hook: string; required: boolean; why: string }> = [
  { hook: "rebuildScopePoliciesTx", required: true, why: "PUT 权限保存主路径" },
  { hook: "projectAdminForNewLibraryTx", required: true, why: "建库 seed 管理员投影" },
  { hook: "projectAdminForNewTableTx", required: true, why: "建表补管理员表节点" },
  { hook: "syncTableForAllScopesTx", required: false, why: "建/删表级联" },
  { hook: "resyncTableMaskTx", required: false, why: "字段结构变更重算 mask" },
];

// 由本文件位置推出 apps/api/src（不依赖 cwd）：scripts/authz/preflight.ts -> ../../src
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "__tests__" || e.name === "dist") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith(".ts")) out.push(full);
  }
}

/** 静态事实：每个钩子在 src 下的真实调用点（排除其自身定义行，避免把定义算成接线）。 */
function scanWiring(): Array<{ hook: string; required: boolean; why: string; callSites: string[] }> {
  const files: string[] = [];
  walk(SRC_DIR, files);
  return HOOKS.map(({ hook, required, why }) => {
    const callSites: string[] = [];
    const defRe = new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${hook}\\b`);
    const callRe = new RegExp(`\\b${hook}\\s*\\(`);
    for (const f of files) {
      const lines = fs.readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (defRe.test(line)) return;
        if (!callRe.test(line)) return;
        callSites.push(`${path.relative(path.dirname(SRC_DIR), f)}:${i + 1}`);
      });
    }
    return { hook, required, why, callSites };
  });
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("缺少 DATABASE_URL，形如 file:/var/lib/gouxiangdb/app.db");
    return 64;
  }
  const file = resolveDatabaseFile(url, path.join(process.cwd(), "prisma"));
  if (!fs.existsSync(file)) {
    console.error(`数据库文件不存在：${file}`);
    return 64;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("用法：preflight.ts [--json]");
    return 64;
  }

  const prisma = new PrismaClient();
  try {
    const data = await prisma.$transaction((tx) => computePreflightData(tx), TX_OPTS);
    const facts: PreflightFacts = { enforceReady: AUTHZ_ENFORCE_READY, hooks: scanWiring() };
    const report = evaluatePreflight(data, facts);

    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHuman(report);
    }
    return report.verdict === "READY" ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

function printHuman(r: PreflightReport): void {
  console.log(`== 通电前体检：${r.verdict}`);
  const c = r.data.coverage;
  console.log("[1] 存量覆盖");
  console.log(
    `    role_library_scope=${c.scopeRows} 行（涉及 ${c.scopeRoles} 个角色；参与对账活角色 ${c.auditedRoles}）`,
  );
  console.log(
    `    auth_policies reason='scope:role'=${c.stored} 行，期望=${c.expected} 行，缺口=${c.gap}`,
  );
  console.log(
    `    零投影角色（期望>0 现存=0）：${c.rolesWithoutProjection.length ? c.rolesWithoutProjection.join(", ") : "无"}`,
  );
  if (c.danglingProjectionRoles.length > 0) {
    console.log(`    指向已删角色的投影：${c.danglingProjectionRoles.join(", ")}`);
  }

  console.log("[2] 对账（reconcile）");
  const s = r.data.reconcile.summary;
  console.log(`    A=${s.A} B=${s.B} C=${s.C} S=${s.S}`);
  for (const item of r.data.reconcile.byCode) {
    console.log(`    [${item.kind === "blocking" ? "阻断" : "提示"}] ${item.code} ${item.count}`);
  }

  console.log("[3] 库级聚合位等价性（抽样：库节点 enter/edit_data vs legacy visible/canEditData）");
  const rc = r.data.reachability;
  console.log(
    `    抽样=${rc.sampled} 不等价=${rc.mismatches}（非 0 即 on 态误拒/越权，先跑 project-scope --apply）`,
  );
  for (const s of rc.samples.slice(0, 5)) {
    console.log(`    ${s.roleId}@${s.libraryId} ${s.action}：引擎=${s.engine} legacy=${s.legacy}`);
  }
  if (rc.errors > 0) console.log(`    引擎判定抛错 ${rc.errors} 次（nav 节点缺失？先跑 reconcile-nav）`);

  console.log("[4] 库节点是否在可见集（S4 同源内核；非空即库整层消失）");
  console.log("    触发条件：GX_AUTHZ_ENGINE=on 即生效，与 AUTHZ_ENFORCE_READY 无关"
    + "（navPruneEnforceEffective 读原始 env，configAuthz.ts:85）");
  const sv = r.data.scopeVisibility;
  console.log(
    `    非 owner 用户抽样=${sv.sampledUsers}（跳过 owner ${sv.ownerSkipped}）`
      + ` 库节点抽样=${sv.checked} 其中可见=${sv.visible}`,
  );
  console.log(
    `    表/视图可见但库节点全不可见的用户=${sv.orphanTableUsers}（非 0 即 M5 收敛与 M3 剪枝把库抹掉）`,
  );
  console.log("    连带：prune.ts resourceAncestorsPass 沿 parentId 向上，任一资源祖先不可见即拒"
    + " -> 库被剪则库内表/视图一并消失");
  for (const s of sv.samples.slice(0, 5)) {
    console.log(`    ${s.userId.slice(-6)}@${s.nodeId}（${s.kind}）r=${s.visible}`);
  }
  if (sv.errors > 0) console.log(`    可见集抽样抛错 ${sv.errors} 次（nav 面问题？先跑 reconcile-nav）`);

  console.log("[5] legacy 残留");
  const lg = r.data.legacy;
  console.log(
    `    legacy:* =${lg.total} 行（${
      Object.entries(lg.byReason).map(([k, v]) => `${k}=${v}`).join(" ") || "无"
    }）；不自动删，退役属后续切片`,
  );
  console.log(
    `    其他策略行（${
      Object.entries(lg.others).map(([k, v]) => `${k}=${v}`).join(" ") || "无"
    }）`,
  );

  console.log("[6] 双写接线（静态扫描 apps/api/src，不含 __tests__）");
  for (const h of r.facts.hooks) {
    const tag = h.required ? "主路径" : "结构性";
    const where = h.callSites.length ? h.callSites.join(", ") : "无调用点";
    console.log(`    [${tag}] ${h.hook}（${h.why}）：${where}`);
  }

  console.log("[7] 门");
  console.log(`    AUTHZ_ENFORCE_READY=${r.facts.enforceReady}（本脚本只读，不翻门）`);

  console.log(`阻断项（${r.blocking.length}）：`);
  for (const b of r.blocking) console.log(`  - ${b}`);
  if (r.blocking.length === 0) console.log("  - 无");
  console.log(`提示项（${r.advisory.length}，不阻断）：`);
  for (const a of r.advisory) console.log(`  - ${a}`);
  if (r.advisory.length === 0) console.log("  - 无");

  console.log(
    r.verdict === "READY"
      ? "判定：READY（数据面与门均就绪；翻门仍需项目总监下令）"
      : `判定：NOT_READY（阻断 ${r.blocking.length} 项）`,
  );
}

main()
  .then((rc) => process.exit(rc))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
