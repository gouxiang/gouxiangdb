#!/usr/bin/env node
// apps/api/scripts/authz/reconcile-policies.ts
// M4/S2 auth_policies 与旧三表投影对账（M4 计划 §5.4）。
//
// 用法（cwd=apps/api）：
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/reconcile-policies.ts            # 只读报告，有差异 exit 1
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/reconcile-policies.ts --apply    # 修 A1/A2/B1/B2/B3
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/reconcile-policies.ts --json      # 只输出 JSON
//
// 纪律（对齐 scripts/nav/reconcile-nav.ts，但避开架构师 S11-A 记录的 config 闸门坑）：
//   - 只读默认；--apply 与迁移/backfill.ts 共用同一套期望规则；连跑第二次必须 no changes。
//   - A3（疑似手工污染）/C 类（结构合法性）只报告不自动改；D 类决策漂移 S3 后补。
//   - 本 CLI 不 import src/config.ts（其 JWT_SECRET 启动闸门会在纯运维场景误退出），
//     只从 DATABASE_URL 解析库路径；不写审计（投影修复是幂等运维动作，非运行时请求）。

import path from "node:path";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { resolveDatabaseFile } from "../../src/db/databaseFile.js";
import {
  applyAuthzReconcileFixes,
  computeAuthzReconcile,
  type ReconcileReport,
} from "../../src/domain/authz/reconcile.js";

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
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

  const apply = hasFlag("--apply");
  const jsonOnly = hasFlag("--json");
  const prisma = new PrismaClient();
  try {
    const before = await prisma.$transaction((tx) => computeAuthzReconcile(tx));
    if (apply) {
      const fix = await prisma.$transaction((tx) => applyAuthzReconcileFixes(tx));
      const after = await prisma.$transaction((tx) => computeAuthzReconcile(tx));
      if (jsonOnly) {
        console.log(JSON.stringify({ before, fix, after }, null, 2));
      } else {
        printHuman(before, "修复前");
        console.log(`修复动作：created=${fix.created} updated=${fix.updated} deleted=${fix.deleted} skipped=${fix.skipped}`);
        printHuman(after, "修复后");
        console.log(`行数：expected=${after.counts.expected} policies=${after.counts.policies} legacy=${after.counts.legacyPolicies}`);
      }
      const remaining = after.summary.A + after.summary.B + after.summary.C;
      if (remaining > 0) {
        console.error(`仍有 ${remaining} 项差异（A3/C 类不自动修，按 runbook 人工处理）`);
        return 1;
      }
      const changed = fix.created + fix.updated + fix.deleted;
      console.log(changed === 0 ? "no changes" : `applied changes=${changed}`);
      return 0;
    }

    if (jsonOnly) {
      console.log(JSON.stringify(before, null, 2));
    } else {
      printHuman(before, "对账");
      console.log(`行数：expected=${before.counts.expected} policies=${before.counts.policies} legacy=${before.counts.legacyPolicies}`);
    }
    return before.summary.A + before.summary.B + before.summary.C === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

function printHuman(r: ReconcileReport, title: string): void {
  console.log(`== ${title}: A=${r.summary.A} B=${r.summary.B} C=${r.summary.C}`);
  for (const [tag, group] of [["A", r.A], ["B", r.B], ["C", r.C]] as const) {
    for (const d of group) console.log(`  [${tag}/${d.code}] ${d.message}${d.ref ? ` (${d.ref})` : ""}`);
  }
}

main()
  .then((rc) => process.exit(rc))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
