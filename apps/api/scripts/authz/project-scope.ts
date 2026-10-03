#!/usr/bin/env node
// apps/api/scripts/authz/project-scope.ts
// 通电前【存量 scope 全量投影】：把库里既有 role_library_scope 一次性展开进 auth_policies
//（reason='scope:role'），补上双写只覆盖写路径留下的存量缺口。
//
// 用法（cwd=apps/api）：
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/project-scope.ts            # 只读报告，有差异 exit 1
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/project-scope.ts --apply    # 单事务写入，修完 exit 0
//   DATABASE_URL=file:/abs/app.db pnpm tsx scripts/authz/project-scope.ts --json      # 只输出 JSON
//
// 纪律（与 reconcile-policies.ts 同一口径，运维不会误用）：
//   - 只读默认；--apply 才写库，且全部落在【一个】写事务内；
//   - 期望集与比较规则全部来自 scopeProjectionReconcile + scopeDoubleWrite（同源，禁止第二套规则）；
//   - 幂等：连跑第二次 changed=0，打印 no changes、exit 0；
//   - 只碰 reason='scope:role' 的行，legacy:* / policy:v1 / user 行一根不碰（由权威修复路径保证）。
//
// 与 reconcile-policies.ts 的分工（别混淆）：
//   本脚本 = 通电前必跑的【存量投影】入口；reconcile-policies = 漂移巡检（--apply 也顺带修 S 段，
//   同源同幂等，两者不冲突）。要问"现在能不能通电"请用 preflight.ts。

import path from "node:path";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { resolveDatabaseFile } from "../../src/db/databaseFile.js";
import {
  applyScopeBackfill,
  planScopeBackfill,
  type ScopeBackfillApplyResult,
  type ScopeBackfillPlan,
} from "../../src/domain/authz/scopeBackfill.js";

/** 交互事务超时：大库逐库 loadLiveShape 会超过 Prisma 默认 5s，显式放宽（不是掩盖挂死）。 */
const TX_OPTS = { timeout: 120_000, maxWait: 30_000 } as const;

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
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log("用法：project-scope.ts [--apply] [--json]");
    return 64;
  }

  const apply = hasFlag("--apply");
  const jsonOnly = hasFlag("--json");
  const prisma = new PrismaClient();
  try {
    const before = await prisma.$transaction((tx) => planScopeBackfill(tx), TX_OPTS);
    if (apply) {
      const fix: ScopeBackfillApplyResult =
        await prisma.$transaction((tx) => applyScopeBackfill(tx, before), TX_OPTS);
      const after = await prisma.$transaction((tx) => planScopeBackfill(tx), TX_OPTS);
      if (jsonOnly) {
        console.log(JSON.stringify({ before, fix, after }, null, 2));
      } else {
        printHuman(before, "修复前");
        console.log(
          `修复动作：created=${fix.created} updated=${fix.updated} deleted=${fix.deleted} skipped=${fix.skipped}`,
        );
        printHuman(after, "修复后");
      }
      if (after.totals.changed > 0) {
        console.error(`仍有 ${after.totals.changed} 项未投影（按 runbook 人工处理）`);
        return 1;
      }
      const changed = fix.created + fix.updated + fix.deleted;
      console.log(changed === 0 ? "no changes" : `applied changes=${changed}`);
      return 0;
    }

    if (jsonOnly) {
      console.log(JSON.stringify(before, null, 2));
    } else {
      printHuman(before, "存量投影");
    }
    if (before.totals.changed > 0) return 1;
    console.log("no changes");
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

function printHuman(p: ScopeBackfillPlan, title: string): void {
  const t = p.totals;
  console.log(
    `== ${title}：scope 行=${t.scopeRows} 期望投影=${t.expected} 现存=${t.stored} `
      + `待新增=${t.toCreate} 待更新=${t.toUpdate} 待删除=${t.toDelete}`,
  );
  for (const r of p.roles) {
    console.log(
      `  [${r.roleId}] scope行=${r.scopeRows} 期望=${r.expected} 现存=${r.stored} `
        + `+${r.toCreate} ~${r.toUpdate} -${r.toDelete}`,
    );
  }
}

main()
  .then((rc) => process.exit(rc))
  .catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
