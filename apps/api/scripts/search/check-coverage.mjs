#!/usr/bin/env node
// apps/api/scripts/search/check-coverage.mjs
// M5/S5 覆盖度只读巡检（M5-implementation-plan §5.5 A-F）。
//
// 用法（cwd=apps/api）：
//   DATABASE_URL=file:/abs/app.db [GX_SEARCH_DB_PATH=/abs/search.db] \
//   [GX_EMBEDDING_MODE=cloud] node scripts/search/check-coverage.mjs [--json]
//
// 纯 node ESM + better-sqlite3 直读两个物理库（不经 Prisma 引擎）：
//   - 主库（DATABASE_URL，相对路径相对 prisma/）：records/kb_docs/nav_nodes 活集合；
//   - 派生库 search.db（GX_SEARCH_DB_PATH，否则 <主库同目录>/search.db）：chunks/fts/vec/field_grant。
// 对账六类：
//   A 主库活实体无任何 chunk（漏索引）            损坏类 -> exit 非0
//   B chunk 对应实体不存在/已删（脏行）           损坏类 -> exit 非0
//   C chunks.nodeId 在 nav 无活节点（悬空，可自愈） 警告   -> exit 0
//   D cloud 下 chunk 缺 vec 行（向量欠账）          警告   -> exit 0（off 跳过 D）
//   E chunk 缺 fts 行                             损坏类 -> exit 非0
//   F field chunk 缺 field_grant 行（授权漏登）     损坏类 -> exit 非0
// 另报 index_meta.capped_records（超 N 截断记录数）。只读，绝不写任何库。

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const BLOCKING = new Set(["A", "B", "E", "F"]);
const SAMPLE_LIMIT = 20;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(name) {
  return process.argv.includes(name);
}

/** 镜像 src/db/databaseFile.resolveDatabaseFile（.mjs 无法 import TS；改算法须同步）。 */
function resolveDbFile(databaseUrl, prismaDir) {
  const raw = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl;
  const noQuery = raw.split("?")[0] ?? raw;
  return path.isAbsolute(noQuery) ? noQuery : path.resolve(prismaDir, noQuery);
}

function openRo(file) {
  return new Database(file, { readonly: true, fileMustExist: true });
}

function sample(arr) {
  return arr.slice(0, SAMPLE_LIMIT);
}

/**
 * 计算 A-F 覆盖度。入参两个物理库路径；mode=cloud 才计算 D。
 * 返回结构化结果（不抛业务性差异；库打不开由调用方处理）。
 */
export function computeCoverage({ mainDbPath, searchDbPath, mode = "off" }) {
  const main = openRo(mainDbPath);
  const search = openRo(searchDbPath);
  try {
    // ---- 主库活实体集合 ----
    const liveRecords = new Set(
      main.prepare("SELECT id FROM records WHERE deletedAt IS NULL").all().map((r) => r.id),
    );
    const docRows = main
      .prepare("SELECT id, kind FROM kb_docs WHERE deletedAt IS NULL")
      .all();
    const liveDocs = new Set(docRows.filter((r) => r.kind === "doc").map((r) => r.id));
    const liveCanvas = new Set(docRows.filter((r) => r.kind === "canvas").map((r) => r.id));
    const liveNodeIds = new Set(
      main
        .prepare(
          `SELECT resourceType, resourceId FROM nav_nodes
           WHERE deletedAt IS NULL AND resourceId IS NOT NULL AND resourceType IS NOT NULL`,
        )
        .all()
        .map((r) => `nav_${r.resourceType}_${r.resourceId}`),
    );

    // ---- search.db 派生集合 ----
    const chunks = search
      .prepare(
        `SELECT rowid, chunkId, entityType, entityId, nodeId, chunkKind, fieldId
         FROM chunks`,
      )
      .all();
    const ftsRowids = new Set(search.prepare("SELECT rowid FROM fts_chunks").all().map((r) => r.rowid));
    const vecTableExists =
      search
        .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
        .get() !== undefined;
    const vecRowids = vecTableExists
      ? new Set(search.prepare("SELECT rowid FROM vec_chunks").all().map((r) => r.rowid))
      : new Set();
    const grantRowids = new Set(search.prepare("SELECT chunkRowid FROM field_grant").all().map((r) => r.chunkRowid));

    const entityChunks = { record: new Set(), doc: new Set(), canvas: new Set() };
    const A = [];
    const B = [];
    const C = [];
    const D = [];
    const E = [];
    const F = [];

    for (const c of chunks) {
      (entityChunks[c.entityType] ??= new Set()).add(c.entityId);
      if (!liveNodeIds.has(c.nodeId)) C.push({ chunkId: c.chunkId, nodeId: c.nodeId });
      if (!ftsRowids.has(c.rowid)) E.push({ chunkId: c.chunkId, rowid: c.rowid });
      if (c.chunkKind === "field" && !grantRowids.has(c.rowid)) {
        F.push({ chunkId: c.chunkId, fieldId: c.fieldId });
      }
      if (mode === "cloud" && !vecRowids.has(c.rowid)) {
        D.push({ chunkId: c.chunkId, rowid: c.rowid });
      }
    }

    // A：活实体无任何 chunk
    for (const id of liveRecords) if (!entityChunks.record.has(id)) A.push({ entityType: "record", entityId: id });
    for (const id of liveDocs) if (!entityChunks.doc.has(id)) A.push({ entityType: "doc", entityId: id });
    for (const id of liveCanvas) if (!entityChunks.canvas.has(id)) A.push({ entityType: "canvas", entityId: id });

    // B：chunk 实体不存在/已删
    for (const c of chunks) {
      const alive =
        c.entityType === "record" ? liveRecords.has(c.entityId)
        : c.entityType === "doc" ? liveDocs.has(c.entityId)
        : c.entityType === "canvas" ? liveCanvas.has(c.entityId)
        : false;
      if (!alive) B.push({ entityType: c.entityType, entityId: c.entityId, chunkId: c.chunkId });
    }

    const cappedRecords = Number(
      search.prepare("SELECT v FROM index_meta WHERE k='capped_records'").get()?.v ?? "0",
    );

    const counts = { A: A.length, B: B.length, C: C.length, D: D.length, E: E.length, F: F.length };
    const blockingCodes = Object.keys(counts).filter((k) => BLOCKING.has(k) && counts[k] > 0);
    return {
      mode,
      vecTableExists,
      counts,
      cappedRecords,
      exitCode: blockingCodes.length > 0 ? 1 : 0,
      blockingCodes,
      samples: {
        A: sample(A), B: sample(B), C: sample(C),
        ...(mode === "cloud" ? { D: sample(D) } : {}),
        E: sample(E), F: sample(F),
      },
    };
  } finally {
    main.close();
    search.close();
  }
}

function main() {
  const asJson = hasFlag("--json");
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("缺少 DATABASE_URL，形如 file:/var/lib/gouxiangdb/app.db");
    return 64;
  }
  const prismaDir = path.join(process.cwd(), "prisma");
  const mainDbPath = resolveDbFile(url, prismaDir);
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
    ? "cloud"
    : "off";

  let report;
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

// 仅在被直接执行时运行 CLI（被 vitest import 时不触发）。
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
