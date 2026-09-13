#!/usr/bin/env node
// apps/api/scripts/bench/gen-data.ts
// M1/S9 确定性压测数据生成器（纯数据直插，不实例化 Prisma / 不调 domain）。
//
// 用法：
//   DATABASE_URL=file:/abs/bench.db pnpm tsx scripts/bench/gen-data.ts \
//     --rows 500000 --shape wide --seed 20260913 [--tables 1] [--soft-delete 0.05] \
//     [--manifest /path/manifest.json]
//
// 流程：prisma migrate deploy 建同构库 → better-sqlite3 直写身份/表/字段/view/records/
//   link_rows（结构由 gen/schema.ts 固定 id 直写，严格复刻 createField/createLinkFieldPair
//   最终态）→ policy.buildExpectedRows 单一事实源回填 record_field_index →
//   wal_checkpoint 自洽 → 输出 manifest（含真实 table/view/field id 与计数，供 run-gate 读取）。
//
// 复现：结构 id 走 prng.seqId 全局序列（resetIds 复位），数据值走可种子 Rng，时间戳走
//   BASE_MS + 确定性偏移；禁 Math.random/Date.now 参与数据。同 --seed/--rows/--shape 两次
//   生成的 records.fields JSON key 与数据分布逐字节一致。

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { Rng, resetIds } from "./gen/prng.js";
import {
  BENCH_EMAIL,
  BENCH_PASSWORD,
  buildIdentities,
  buildNarrowShape,
  buildWideShape,
  fieldCount,
  type FieldHandle,
  type Shape,
} from "./gen/schema.js";
import { genMainRow, genPeerRow, genNarrowRow, type RowSpec } from "./gen/rows.js";
import { populate, type PopulateResult } from "./gen/insert.js";

interface Args {
  rows: number;
  shape: "wide" | "narrow";
  seed: number;
  tables: number;
  softDelete: number;
  manifest: string;
}

function parseArgs(): Args {
  const get = (flag: string, def: string) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? (process.argv[i + 1] ?? def) : def;
  };
  const rows = Number(get("--rows", "10000"));
  if (!Number.isInteger(rows) || rows <= 0) throw new Error("--rows 必须为正整数");
  const shape = get("--shape", "wide") === "narrow" ? "narrow" : "wide";
  const seed = Number(get("--seed", "20260913")) >>> 0;
  const tables = Math.max(1, Number(get("--tables", "1")) || 1);
  const softDelete = Number(get("--soft-delete", "0.05"));
  const manifest = get("--manifest", "");
  return { rows, shape, seed, tables, softDelete, manifest };
}

function dbFileFromEnv(): string {
  const url = process.env.DATABASE_URL;
  if (!url || !url.startsWith("file:")) {
    throw new Error("必须提供绝对路径 DATABASE_URL=file:/abs/bench.db");
  }
  const file = url.slice("file:".length);
  if (!path.isAbsolute(file)) throw new Error("DATABASE_URL 必须是绝对路径（防 cwd 漂移）");
  return file;
}

/** 生成一表的行负载；数据与关联用相互独立的派生 RNG，避免行数变化互相污染序列。 */
function buildRows(s: Shape, args: Args): { mainRows: RowSpec[]; peerRows: RowSpec[]; linkRng: Rng } {
  const opts = { softDeleteRate: args.softDelete, longTextRate: 0.1, dirtyRate: 0.005 };
  const dataRng = new Rng(args.seed);
  const mainRows: RowSpec[] = [];
  const peerRows: RowSpec[] = [];
  if (s.peerTableId) {
    for (let i = 0; i < args.rows; i++) {
      mainRows.push(genMainRow(s, dataRng, i, opts));
      if (i < Math.max(1, Math.floor(args.rows * 0.4))) peerRows.push(genPeerRow(s, dataRng, i, opts));
    }
  } else {
    for (let i = 0; i < args.rows; i++) mainRows.push(genNarrowRow(s, dataRng, i, opts));
  }
  // 关联分布独立派生（与行数据解耦），确定性且不依赖前面消耗了多少随机数。
  const linkRng = new Rng((args.seed ^ 0x9e3779b9) >>> 0);
  return { mainRows, peerRows, linkRng };
}

function fieldCatalog(handles: Record<string, FieldHandle>) {
  return Object.fromEntries(
    Object.entries(handles).map(([key, h]) => [key, { id: h.id, name: h.name, type: h.type }]),
  );
}

interface TableReport {
  mainTableId: string;
  peerTableId: string | null;
  viewId: string;
  mainFields: number;
  peerFields: number;
  mainLive: number;
  mainSoftDeleted: number;
  peerRows: number;
  linksMm: number;
  linksHm: number;
  sidecarRows: number;
  fieldIds: Record<string, { id: string; name: string; type: string }>;
  peerFieldIds: Record<string, { id: string; name: string; type: string }>;
}

function main() {
  const args = parseArgs();
  const dbFile = dbFileFromEnv();
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.rmSync(dbFile, { force: true });
  for (const ext of ["-wal", "-shm"]) fs.rmSync(dbFile + ext, { force: true });

  console.log(`[gen] 迁移建库 → ${dbFile}`);
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(),
    stdio: "ignore",
    env: process.env,
  });

  // 结构 id 全局序列复位，保证同参数跨次逐字节复现。
  resetIds(1);
  const identity = buildIdentities();

  const db = new Database(dbFile, { timeout: 120_000 });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  const t0 = Date.now();
  const shapes: Shape[] =
    args.shape === "wide"
      ? [buildWideShape(identity)] // wide 固定 main+peer 两表（--tables 忽略）
      : Array.from({ length: args.tables }, () => buildNarrowShape(identity));

  const tableReports: TableReport[] = [];
  let totalSidecar = 0;
  shapes.forEach((s, ti) => {
    const { mainRows, peerRows, linkRng } = buildRows(s, args);
    // 多 narrow 表必须用不同记录 id 前缀，否则跨表 recId 撞（全局唯一）。
    const mainPrefix = args.shape === "wide" ? "rec_m" : `rec_${ti.toString(36)}_`;
    const r: PopulateResult = populate(
      db, s, identity.ownerId,
      { mainRows, peerRows, rng: linkRng },
      ti > 0, // narrow 多表共享同一 owner，仅首表插身份
      mainPrefix,
      s.peerTableId ? "rec_p" : "rec_p",
    );
    totalSidecar += r.sidecarRows;
    const counts = fieldCount(s);
    tableReports.push({
      mainTableId: s.mainTableId,
      peerTableId: s.peerTableId || null,
      viewId: s.viewId,
      mainFields: counts.main,
      peerFields: counts.peer,
      mainLive: r.live,
      mainSoftDeleted: r.softDeleted,
      peerRows: peerRows.length,
      linksMm: r.linksMm,
      linksHm: r.linksHm,
      sidecarRows: r.sidecarRows,
      fieldIds: fieldCatalog(s.main),
      peerFieldIds: fieldCatalog(s.peer),
    });
  });

  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  const sizeBytes = fs.statSync(dbFile).size;
  const durationMs = Date.now() - t0;

  const manifest = {
    version: 1,
    seed: args.seed,
    rows: args.rows,
    shape: args.shape,
    tables: shapes.length,
    softDeleteRate: args.softDelete,
    ownerEmail: BENCH_EMAIL,
    ownerPassword: BENCH_PASSWORD, // 仅本地压测固定弱口令，run-gate 真实登录用
    baseId: identity.baseId,
    ownerId: identity.ownerId,
    dbFile,
    sizeBytes,
    durationMs, // 墙上耗时（运维信息，非数据，不参与复现对账）
    tableReports,
  };
  const manifestPath = args.manifest || dbFile.replace(/\.db$/, ".manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log("[gen] 完成：");
  console.log(JSON.stringify({
    shape: args.shape,
    rows: args.rows,
    tables: shapes.length,
    mainFields: tableReports[0]!.mainFields,
    peerFields: tableReports[0]!.peerFields,
    mainLive: tableReports.reduce((a, t) => a + t.mainLive, 0),
    softDeleted: tableReports.reduce((a, t) => a + t.mainSoftDeleted, 0),
    linksMm: tableReports.reduce((a, t) => a + t.linksMm, 0),
    linksHm: tableReports.reduce((a, t) => a + t.linksHm, 0),
    sidecarRows: totalSidecar,
    sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
    durationMs,
    manifest: manifestPath,
  }, null, 2));
}

main();
