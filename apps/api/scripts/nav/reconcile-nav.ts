#!/usr/bin/env node
// apps/api/scripts/nav/reconcile-nav.ts
// M3 nav_nodes/menu_items 对账与幂等修复（计划 §5.4）。
//
// 用法（cwd=apps/api）：
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/nav/reconcile-nav.ts            # 只读报告，有差异 exit 1
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/nav/reconcile-nav.ts --apply    # 修 A/B3/C4 + path 重建
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/nav/reconcile-nav.ts --apply --purge-broken
//                                                                                 # 连 B1/C1 broken 一起物理清理
//   pnpm tsx scripts/nav/reconcile-nav.ts --json    # 只输出 JSON（供 CI/巡检解析）
//
// 纪律：只读默认；--apply 与迁移回填/S3 sync 共用 domain/nav/backfill.ts 同一套期望规则；
//      broken 清理必须显式 --purge-broken；重复执行第二次必须 no changes。
//      C4 未收纳是 warning（2026-09-12 方案 A 裁决），--apply 不自动补 shortcut，
//      exit code 只看阻断类 A/B/C1-C3；warnings 仅展示。
// migrate deploy 后必须先跑一次 --apply 以全量重建非根节点 path/depth（迁移 B 只给根节点 path）。

import path from "node:path";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { resolveDatabaseFile } from "../../src/db/databaseFile.js";
import { computeDiffs, applyFixesTx, type ReconcileReport } from "../../src/domain/nav/reconcile.js";
import { config } from "../../src/config.js";
import { writeAudit } from "../../src/audit/audit.js";

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
  const purgeBroken = hasFlag("--purge-broken");
  const jsonOnly = hasFlag("--json");
  if (purgeBroken && !apply) {
    console.error("--purge-broken 必须与 --apply 同时给出");
    return 64;
  }

  const prisma = new PrismaClient();
  try {
    const before = await prisma.$transaction((tx) => computeDiffs(tx));
    if (apply) {
      const result = await prisma.$transaction((tx) => applyFixesTx(tx, { purgeBroken }));
      const after = await prisma.$transaction((tx) => computeDiffs(tx));
      if (jsonOnly) {
        console.log(JSON.stringify({ before, fix: result, after }, null, 2));
      } else {
        printHuman(before, "修复前");
        console.log("修复动作：", JSON.stringify(result));
        printHuman(after, "修复后");
      }
      const remaining = after.summary.A + after.summary.B + after.summary.C;
      if (remaining > 0) {
        console.error(`仍有 ${remaining} 项阻断差异（broken 需 --purge-broken？）`);
        return 1;
      }
      const changed =
        result.nodes.created + result.nodes.updated + result.nodes.revived +
        result.nodes.pathsRebuilt +
        result.softDeleted.nodes + result.softDeleted.shortcuts +
        result.purged.shortcuts + result.purged.nodes;
      // --purge-broken 物理清理 broken 节点/shortcut 是破坏性运维动作，写审计 JSONL 留痕
      // （脚本无 Hono 上下文，直接 append 同格式行，actor 固定为 reconcile-script）。
      if (purgeBroken && (result.purged.nodes > 0 || result.purged.shortcuts > 0)) {
        writeAudit(config.auditDir, {
          event: "nav_broken_purged",
          actorId: "reconcile-script",
          method: "CLI",
          path: "scripts/nav/reconcile-nav.ts --apply --purge-broken",
          status: 200,
          detail: { purgedNodes: result.purged.nodes, purgedShortcuts: result.purged.shortcuts },
        });
      }
      console.log(changed === 0 ? "no changes" : `applied changes=${changed}`);
      if (after.summary.warnings > 0) {
        console.log(`warnings=${after.summary.warnings}（C4 未收纳/C5 ord 重复，不阻断；--apply 不自动收纳）`);
      }
      return 0;
    }

    if (jsonOnly) {
      console.log(JSON.stringify(before, null, 2));
    } else {
      printHuman(before, "对账");
    }
    return before.summary.A + before.summary.B + before.summary.C === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

function printHuman(r: ReconcileReport, title: string): void {
  console.log(`== ${title}: A=${r.summary.A} B=${r.summary.B} C=${r.summary.C} warnings=${r.summary.warnings}`);
  for (const group of [r.A, r.B, r.C, r.warnings] as const) {
    for (const d of group) console.log(`  [${d.code}] ${d.message}${d.ref ? ` (${d.ref})` : ""}`);
  }
}

main()
  .then((rc) => process.exit(rc))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
