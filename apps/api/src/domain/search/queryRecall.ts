// M5/S7 search.db 召回会话：在【单次同步、无 await 区段】内完成"建 TEMP 表 -> 批量 INSERT ->
// FTS/LIKE/vec 三路召回全部跑完"，杜绝共享单例连接上固定名 TEMP TABLE 跨 await 被并发请求污染。
//
// 权威依据：M5-implementation-plan.md §4.5（4a/4b/4c + 步骤 3）、§4.7（三分支谓词）。
//
// 并发纪律（派工硬红线 2）：
//   - getSearchStore 是进程级单例裸连接；auto+cloud 路的 await provider.embed() 必须在调用本会话
//     【之前】完成（query 编排先算查询向量），进入本文件后再不夹任何 await；
//   - TEMP 表用唯一后缀名（temp_scope_<uuid> / temp_field_grant_<uuid>），两并发请求即使共用
//     同一连接也不撞名；finally 内 DROP，异常也清理；
//   - 全部走 store.db 这一条已加载 vec0 的连接（只读召回不建第二连接——只读连接无法建 TEMP 表）。
//
// 三分支 allowed（§4.5 步骤 4a / queryPlan.buildAllowedPredicate）：
//   identity 恒可见 OR 该表在 temp_field_grant 无任何行（无 mask）OR 命中该主体白名单 (table,field)。
// 表级越权由 temp_scope INNER JOIN 先行剔除；temp_field_grant 只物化有 mask 表的白名单行。

import { randomUUID } from "node:crypto";
import type { SearchQueryPlan } from "./queryPlan.js";
import { vecBlob } from "./vecLoader.js";
import type { SearchDbLike } from "./queryTypes.js";

/** 单条路内命中（rank 1 基，由调用方按结果顺序赋）。 */
export interface RouteRow {
  rowid: bigint;
  entityType: string;
  entityId: string;
  chunkKind: "identity" | "field";
  fieldId: string | null;
  title: string;
  body: string;
  nodeId: string;
  seq: number;
  /** 路内名次（1 基）。 */
  rank: number;
}

export interface RecallResult {
  fts: RouteRow[];
  like: RouteRow[];
  vec: RouteRow[];
  /** 实际跑了哪些路（供编排决定 mode/degraded/metric）。 */
  ran: { fts: boolean; like: boolean; vec: boolean };
  /** 各路 EXPLAIN QUERY PLAN 文本（仅 explain=true 时填充，测试断言收敛先于产出）。 */
  plans: Record<string, string[]>;
}

interface RecallOptions {
  /** vec 路查询向量（Float32 BLOB）；null=不跑 vec。 */
  queryVector?: Buffer | null;
  /** 是否同时采集三路 EXPLAIN QUERY PLAN（测试/S11 留证；生产关闭零开销）。 */
  explain?: boolean;
}

interface ChunkCols {
  rowid: number | bigint;
  entityType: string;
  entityId: string;
  chunkKind: string;
  fieldId: string | null;
  title: string;
  body: string;
  nodeId: string;
  seq: number;
}

const BATCH = 499; // §4.5 步骤 3：批量 INSERT 每批 499（SQLite 999 变量上限留余量）。

function ident(suffix: string): { scope: string; grant: string } {
  return { scope: `temp_scope_${suffix}`, grant: `temp_field_grant_${suffix}` };
}

/** allowed 三分支【谓词片段】（表名按唯一后缀内插——后缀来自 randomUUID 非用户输入，无注入面）。
 *  别名约定 chunks c（与 queryPlan.buildAllowedPredicate 一致），供 LIKE 内联形态使用。 */
function allowedPredicate(scopeT: string, grantT: string): string {
  return (
    `(c.chunkKind = 'identity' ` +
    `OR NOT EXISTS (SELECT 1 FROM ${grantT} g0 WHERE g0.tableNodeId = c.nodeId) ` +
    `OR EXISTS (SELECT 1 FROM ${grantT} g WHERE g.tableNodeId = c.nodeId AND g.fieldId = c.fieldId))`
  );
}

/** allowed 行集合（SELECT 形态）：供 FTS JOIN 与 vec rowid IN 子查询使用，body 回查 fts_chunks。 */
function allowedSql(scopeT: string, grantT: string): string {
  return (
    `SELECT c.rowid AS rid, c.entityType AS entityType, c.entityId AS entityId, ` +
    `c.chunkKind AS chunkKind, c.fieldId AS fieldId, c.title AS title, ` +
    `(SELECT f.body FROM fts_chunks f WHERE f.rowid=c.rowid) AS body, c.nodeId AS nodeId, c.seq AS seq ` +
    `FROM chunks c JOIN ${scopeT} s ON s.nodeId = c.nodeId ` +
    `WHERE ${allowedPredicate(scopeT, grantT)}`
  );
}

function toRows(rows: unknown[]): RouteRow[] {
  return (rows as ChunkCols[]).map((r, i) => ({
    rowid: BigInt(r.rowid),
    entityType: r.entityType,
    entityId: r.entityId,
    chunkKind: r.chunkKind === "field" ? "field" : "identity",
    fieldId: r.fieldId,
    title: r.title,
    body: r.body ?? "",
    nodeId: r.nodeId,
    seq: typeof r.seq === "number" ? r.seq : Number(r.seq),
    rank: i + 1,
  }));
}

function planLines(db: SearchDbLike, sql: string, bindings: unknown[]): string[] {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bindings) as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

/** vec_chunks 虚表是否已建（off/fts-only 形态不存在；任何查询前必判，§4.2）。 */
export function vecChunksExists(db: SearchDbLike): boolean {
  return db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
    .get() !== undefined;
}

/**
 * 在单个纯同步会话内物化 scope/field_grant 并跑完计划启用的召回路。
 * 不返回 Promise、不接受异步依赖：调用方必须已在外部 await 完 embed(q)。
 */
export function runRecall(
  db: SearchDbLike,
  plan: SearchQueryPlan,
  scopeNodeIds: readonly string[],
  grantRows: ReadonlyArray<{ tableNodeId: string; fieldId: string }>,
  opts: RecallOptions = {},
): RecallResult {
  const suffix = randomUUID().replace(/-/g, "");
  const { scope: scopeT, grant: grantT } = ident(suffix);
  const allowed = allowedSql(scopeT, grantT);
  const result: RecallResult = {
    fts: [], like: [], vec: [],
    ran: { fts: false, like: false, vec: false },
    plans: {},
  };
  try {
    db.exec(`CREATE TEMP TABLE ${scopeT}(nodeId TEXT PRIMARY KEY)`);
    db.exec(`CREATE TEMP TABLE ${grantT}(tableNodeId TEXT, fieldId TEXT)`);

    // 批量 INSERT（每批 499 行，§4.5 步骤 3）：多行 VALUES 单条语句，scope 单列每批 499 变量、
    // grant 双列每批 998 变量，均在 SQLite 999 变量上限内；超出按批切。
    for (let i = 0; i < scopeNodeIds.length; i += BATCH) {
      const chunk = scopeNodeIds.slice(i, i + BATCH);
      const values = chunk.map(() => "(?)").join(",");
      db.prepare(`INSERT INTO ${scopeT}(nodeId) VALUES ${values}`).run(...chunk);
    }
    const GRANT_BATCH = 499; // 2 列 * 499 = 998 <= 999
    for (let i = 0; i < grantRows.length; i += GRANT_BATCH) {
      const chunk = grantRows.slice(i, i + GRANT_BATCH);
      const values = chunk.map(() => "(?,?)").join(",");
      db.prepare(`INSERT INTO ${grantT}(tableNodeId, fieldId) VALUES ${values}`)
        .run(...chunk.flatMap((g) => [g.tableNodeId, g.fieldId]));
    }

    // ---- 4a FTS（码元>=3）：trigram MATCH，allowed CTE JOIN，bm25 序 LIMIT perRoute ----
    if (plan.fts) {
      const sql =
        `WITH allowed AS (${allowed}) ` +
        `SELECT a.rid AS rowid, a.entityType AS entityType, a.entityId AS entityId, ` +
        `a.chunkKind AS chunkKind, a.fieldId AS fieldId, a.title AS title, a.body AS body, ` +
        `a.nodeId AS nodeId, a.seq AS seq ` +
        `FROM fts_chunks JOIN allowed a ON a.rid = fts_chunks.rowid ` +
        `WHERE fts_chunks MATCH ? ORDER BY bm25(fts_chunks) LIMIT ?`;
      const bindings = [...plan.fts.bindings, plan.limits.perRoute];
      if (opts.explain) result.plans.fts = planLines(db, sql, bindings);
      result.fts = toRows(db.prepare(sql).all(...bindings));
      result.ran.fts = true;
    }

    // ---- 4b LIKE（码元<3）：title/body 参数化子串，allowed 同构，LIMIT perRoute ----
    // 用 §4.5 4b 字面形态：chunks c JOIN temp_scope s JOIN fts_chunks f，谓词内联三分支；
    // queryPlan.like.sql 引用别名 c.title / f.body（ESCAPE '\\' 已在计划片段内）。
    if (plan.like) {
      const sql =
        `SELECT c.rowid AS rowid, c.entityType AS entityType, c.entityId AS entityId, ` +
        `c.chunkKind AS chunkKind, c.fieldId AS fieldId, c.title AS title, f.body AS body, ` +
        `c.nodeId AS nodeId, c.seq AS seq ` +
        `FROM chunks c JOIN ${scopeT} s ON s.nodeId = c.nodeId ` +
        `JOIN fts_chunks f ON f.rowid = c.rowid ` +
        `WHERE ${allowedPredicate(scopeT, grantT)} AND ${plan.like.sql} LIMIT ?`;
      const bindings = [...plan.like.bindings, plan.limits.perRoute];
      if (opts.explain) result.plans.like = planLines(db, sql, bindings);
      result.like = toRows(db.prepare(sql).all(...bindings));
      result.ran.like = true;
    }

    // ---- 4c vec KNN（与门通过）：rowid IN (allowed) + entityType IN (bigint)，k=LIMIT ----
    // S11 实测（v0.1.9）：vec0 接受 KNN WHERE 内的 rowid IN (CTE 子查询) 与 entityType IN (bigint)；
    // rowid IN 是独立于 k 截断的扫描约束（100 个更近的越权行 + k=10 仍只返回白名单内 3 行），
    // 收敛发生在 KNN 扫描约束中而非"全量 KNN 后应用层过滤"，故无需 metadata 分桶退路。
    if (opts.queryVector && plan.vector.enabled) {
      const placeholders = plan.vector.entityTypeCodes.map(() => "?").join(",");
      // KNN 子查询保持探针验证过的形态：rowid IN (allowed CTE) + entityType IN (bigint) 是 vec0
      // 虚拟表扫描的约束（独立于 k 截断）；外层再 JOIN allowed 仅为补齐 entityType/title/body 列。
      const sql =
        `WITH allowed AS (${allowed}) ` +
        `SELECT a.rid AS rowid, a.entityType AS entityType, a.entityId AS entityId, ` +
        `a.chunkKind AS chunkKind, a.fieldId AS fieldId, a.title AS title, a.body AS body, ` +
        `a.nodeId AS nodeId, a.seq AS seq, knn.distance AS distance ` +
        `FROM (SELECT rowid AS rid, distance FROM vec_chunks ` +
        `      WHERE embedding MATCH ? AND k = ? AND rowid IN (SELECT rid FROM allowed) ` +
        `      AND entityType IN (${placeholders})) knn ` +
        `JOIN allowed a ON a.rid = knn.rid ORDER BY knn.distance`;
      const bindings: unknown[] = [
        opts.queryVector, BigInt(plan.limits.perRoute),
        ...plan.vector.entityTypeCodes.map((c) => BigInt(c)),
      ];
      if (opts.explain) result.plans.vec = planLines(db, sql, bindings);
      result.vec = toRows(db.prepare(sql).all(...bindings));
      result.ran.vec = true;
    }
    return result;
  } finally {
    db.exec(`DROP TABLE IF EXISTS ${grantT}`);
    db.exec(`DROP TABLE IF EXISTS ${scopeT}`);
  }
}

/** 供编排/测试把已 embed 的 number[]/Float32Array 统一成 vec0 所需 Float32 BLOB。 */
export function toQueryBlob(vector: Float32Array | readonly number[]): Buffer {
  return vecBlob(vector);
}
