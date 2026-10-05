// M5/S9 覆盖度 A-F 判定的唯一真源（M5-implementation-plan §5.5、§9 status.coverage）。
//
// 本模块是 S5 起 scripts/search/check-coverage 巡检逻辑抽出的 domain 函数：
//   - scripts/search/check-coverage.ts（CLI，pnpm tsx 运行）与
//   - routes/v1/adminSearch.ts（GET /admin/search/status 的 coverage 段）
// 都只调用本模块，禁止任一侧另写一份，避免口径漂移（S9 派工硬要求）。
//
// 纯只读：computeCoverageFromConnections 不 open/close 任何连接、绝不写库；
// computeCoverage 是按物理路径以 readonly+fileMustExist 打开两库的薄包装（供 CLI/路由复用）。

import path from "node:path";
import Database from "better-sqlite3";
import type { EmbeddingMode } from "./embedding/types.js";

/** 阻断类（exit 非 0）：A 漏索引 / B 脏行 / E fts 缺失 / F 授权漏登。C 悬空、D 向量欠账仅警告。 */
export const COVERAGE_BLOCKING = new Set(["A", "B", "E", "F"]);
const SAMPLE_LIMIT = 20;

type CoverageCode = "A" | "B" | "C" | "D" | "E" | "F";

interface CoverageCounts {
  A: number;
  B: number;
  C: number;
  D: number;
  E: number;
  F: number;
}

/** status 端点用的小写形状（§9 coverage:{a,b,c,d,e,f}）。 */
export type CoverageStatus = { a: number; b: number; c: number; d: number; e: number; f: number };

export interface CoverageReport {
  mode: EmbeddingMode;
  vecTableExists: boolean;
  counts: CoverageCounts;
  cappedRecords: number;
  exitCode: number;
  blockingCodes: string[];
  /** 各类最多 20 条定位样本；off 模式不产出 D 样本键。 */
  samples: {
    A?: Array<Record<string, unknown>>;
    B?: Array<Record<string, unknown>>;
    C?: Array<Record<string, unknown>>;
    D?: Array<Record<string, unknown>>;
    E?: Array<Record<string, unknown>>;
    F?: Array<Record<string, unknown>>;
  };
}

/** 只读 better-sqlite3 连接所需最小形状（避免域内硬绑具体实例类型）。 */
interface CoverageRoDb {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
}

interface ChunkRow {
  rowid: number | bigint;
  chunkId: string;
  entityType: string;
  entityId: string;
  nodeId: string;
  chunkKind: string;
  fieldId: string | null;
}

function sample<T>(arr: T[]): T[] {
  return arr.slice(0, SAMPLE_LIMIT);
}

/**
 * 核心 A-F 判定：入参两个【已打开】的只读连接（主库 + search.db）。
 * mode=cloud 才计算 D（off 下 chunk 无 vec 行是常态，不算欠账）。
 * 不 open/close 连接，调用方负责生命周期。
 */
function computeCoverageFromConnections(
  main: CoverageRoDb,
  search: CoverageRoDb,
  mode: EmbeddingMode = "off",
): CoverageReport {
  // ---- 主库活实体集合 ----
  const liveRecords = new Set(
    (main.prepare("SELECT id FROM records WHERE deletedAt IS NULL").all() as Array<{ id: string }>)
      .map((r) => r.id),
  );
  const docRows = main
    .prepare("SELECT id, kind FROM kb_docs WHERE deletedAt IS NULL")
    .all() as Array<{ id: string; kind: string }>;
  const liveDocs = new Set(docRows.filter((r) => r.kind === "doc").map((r) => r.id));
  const liveCanvas = new Set(docRows.filter((r) => r.kind === "canvas").map((r) => r.id));
  const liveNodeIds = new Set(
    (main
      .prepare(
        `SELECT resourceType, resourceId FROM nav_nodes
         WHERE deletedAt IS NULL AND resourceId IS NOT NULL AND resourceType IS NOT NULL`,
      )
      .all() as Array<{ resourceType: string; resourceId: string }>)
      .map((r) => `nav_${r.resourceType}_${r.resourceId}`),
  );

  // ---- search.db 派生集合 ----
  const chunks = search
    .prepare(
      `SELECT rowid, chunkId, entityType, entityId, nodeId, chunkKind, fieldId FROM chunks`,
    )
    .all() as ChunkRow[];
  const ftsRowids = new Set(
    (search.prepare("SELECT rowid FROM fts_chunks").all() as Array<{ rowid: number | bigint }>)
      .map((r) => r.rowid),
  );
  const vecTableExists =
    search
      .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
      .get() !== undefined;
  const vecRowids = vecTableExists
    ? new Set(
        (search.prepare("SELECT rowid FROM vec_chunks").all() as Array<{ rowid: number | bigint }>)
          .map((r) => r.rowid),
      )
    : new Set<number | bigint>();
  const grantRowids = new Set(
    (search.prepare("SELECT chunkRowid FROM field_grant").all() as Array<{ chunkRowid: number | bigint }>)
      .map((r) => r.chunkRowid),
  );

  const entityChunks: Record<string, Set<string>> = {
    record: new Set(),
    doc: new Set(),
    canvas: new Set(),
  };
  const A: Array<Record<string, unknown>> = [];
  const B: Array<Record<string, unknown>> = [];
  const C: Array<Record<string, unknown>> = [];
  const D: Array<Record<string, unknown>> = [];
  const E: Array<Record<string, unknown>> = [];
  const F: Array<Record<string, unknown>> = [];

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

  // A：活实体无任何 chunk（漏索引）。
  for (const id of liveRecords) {
    if (!entityChunks.record!.has(id)) A.push({ entityType: "record", entityId: id });
  }
  for (const id of liveDocs) {
    if (!entityChunks.doc!.has(id)) A.push({ entityType: "doc", entityId: id });
  }
  for (const id of liveCanvas) {
    if (!entityChunks.canvas!.has(id)) A.push({ entityType: "canvas", entityId: id });
  }

  // B：chunk 对应实体不存在/已删（脏行）。
  for (const c of chunks) {
    const alive =
      c.entityType === "record" ? liveRecords.has(c.entityId)
      : c.entityType === "doc" ? liveDocs.has(c.entityId)
      : c.entityType === "canvas" ? liveCanvas.has(c.entityId)
      : false;
    if (!alive) B.push({ entityType: c.entityType, entityId: c.entityId, chunkId: c.chunkId });
  }

  const cappedRow = search
    .prepare("SELECT v FROM index_meta WHERE k='capped_records'")
    .get() as { v: string } | undefined;
  const cappedRecords = Number(cappedRow?.v ?? "0");

  const counts: CoverageCounts = {
    A: A.length, B: B.length, C: C.length, D: D.length, E: E.length, F: F.length,
  };
  const blockingCodes = (Object.keys(counts) as CoverageCode[]).filter(
    (k) => COVERAGE_BLOCKING.has(k) && counts[k] > 0,
  );
  return {
    mode,
    vecTableExists,
    counts,
    cappedRecords,
    exitCode: blockingCodes.length > 0 ? 1 : 0,
    blockingCodes,
    samples: {
      A: sample(A),
      B: sample(B),
      C: sample(C),
      ...(mode === "cloud" ? { D: sample(D) } : {}),
      E: sample(E),
      F: sample(F),
    },
  };
}

/** §9 status.coverage 小写形状。 */
export function coverageToStatus(report: CoverageReport): CoverageStatus {
  const c = report.counts;
  return { a: c.A, b: c.B, c: c.C, d: c.D, e: c.E, f: c.F };
}

function openRo(file: string): Database.Database {
  return new Database(file, { readonly: true, fileMustExist: true });
}

/**
 * 按物理路径只读打开两库计算 A-F（CLI 与 status 端点共用）。
 * search.db 不存在由调用方先判（openRo 会抛），主库同理。
 */
export function computeCoverage(args: {
  mainDbPath: string;
  searchDbPath: string;
  mode?: EmbeddingMode;
}): CoverageReport {
  const main = openRo(path.resolve(args.mainDbPath));
  const search = openRo(path.resolve(args.searchDbPath));
  try {
    return computeCoverageFromConnections(main, search, args.mode ?? "off");
  } finally {
    main.close();
    search.close();
  }
}
