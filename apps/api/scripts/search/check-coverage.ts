#!/usr/bin/env node
// apps/api/scripts/search/check-coverage.ts
// M5/S5 覆盖度只读巡检（M5-implementation-plan §5.5 A-F）；S9 起 A-F 判定单一真源在
// src/domain/search/searchCoverage.ts，本 CLI 只负责参数/路径解析与输出（pnpm tsx 运行，
// 与 scripts/{nav,authz}/reconcile-*.ts 同形态）。
//
// 用法（cwd=apps/api）：
//   DATABASE_URL=file:/abs/app.db [GX_SEARCH_DB_PATH=/abs/search.db] \
//   [GX_EMBEDDING_MODE=cloud] pnpm tsx scripts/search/check-coverage.ts [--json]
//
// 纯只读直连两个物理库（不经 Prisma 引擎）：
//   - 主库（DATABASE_URL，相对路径相对 prisma/）：records/kb_docs/nav_nodes 活集合；
//   - 派生库 search.db（GX_SEARCH_DB_PATH，否则 <主库同目录>/search.db）：chunks/fts/vec/field_grant。
// 对账六类（阻断判据以 domain 常量 COVERAGE_BLOCKING 为准）：
//   A 主库活实体无任何 chunk（漏索引）            损坏类 -> exit 非0
//   B chunk 对应实体不存在/已删（脏行）           损坏类 -> exit 非0
//   C chunks.nodeId 在 nav 无活节点（悬空，可自愈） 警告   -> exit 0
//   D cloud 下 chunk 缺 vec 行（向量欠账）          警告   -> exit 0（off 跳过 D）
//   E chunk 缺 fts 行                             损坏类 -> exit 非0
//   F field chunk 缺 field_grant 行（授权漏登）     损坏类 -> exit 非0
// 另报 index_meta.capped_records（超 N 截断记录数）。只读，绝不写任何库。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDatabaseFile } from "../../src/db/databaseFile.js";
import { computeCoverage } from "../../src/domain/search/searchCoverage.js";

const here = path.dirname(fileURLToPath(import.meta.url));
// scripts/search -> apps/api（tsx 下 process.cwd() 一般也是 apps/api，但以脚本位置兜底）。
const apiRoot = path.resolve(here, "..", "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function main(): number {
  const asJson = hasFlag("--json");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("缺少 DATABASE_URL，形如 file:/var/lib/gouxiangdb/app.db");
    return 64;
  }
  const prismaDir = path.join(apiRoot, "prisma");
  const mainDbPath = resolveDatabaseFile(url, prismaDir);
  if (!fs.existsSync(mainDbPath)) {
    console.error(`主库不存在：${mainDbPath}`);
    return 64;
  }
  const searchDbPath =
    process.env.GX_SEARCH_DB_PATH?.trim() || path.join(path.dirname(mainDbPath), "search.db");
  if (!fs.existsSync(searchDbPath)) {
    console.error(`search.db 不存在：${searchDbPath}（worker 尚未建库？）`);
    return 64;
  }
  const mode = (process.env.GX_EMBEDDING_MODE || arg("--mode") || "off").trim().toLowerCase() === "cloud"
    ? "cloud" as const
    : "off" as const;

  let report: ReturnType<typeof computeCoverage>;
  try {
    report = computeCoverage({ mainDbPath, searchDbPath, mode });
  } catch (err) {
    console.error(`巡检失败：${err instanceof Error ? err.message : String(err)}`);
    return 70;
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const c = report.counts;
    console.log(`M5 覆盖度巡检 (mode=${report.mode}, vecTable=${report.vecTableExists})`);
    console.log(`  A 漏索引(阻断)      : ${c.A}`);
    console.log(`  B 脏行(阻断)        : ${c.B}`);
    console.log(`  C 悬空 nodeId(警告) : ${c.C}`);
    console.log(`  D 向量欠账(警告)    : ${mode === "cloud" ? c.D : "n/a (off)"}`);
    console.log(`  E fts 缺失(阻断)    : ${c.E}`);
    console.log(`  F 授权漏登(阻断)    : ${c.F}`);
    console.log(`  capped_records      : ${report.cappedRecords}`);
    console.log(report.exitCode === 0 ? "PASS: 无阻断类差异" : `FAIL: 阻断类 ${report.blockingCodes.join(", ")}`);
  }
  return report.exitCode;
}

// 仅在被直接执行时运行 CLI（被 vitest/tsx import 时不触发）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
