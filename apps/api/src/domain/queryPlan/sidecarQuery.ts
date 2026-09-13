// apps/api/src/domain/queryPlan/sidecarQuery.ts
// M1/S6 sidecar 读执行器（better-sqlite3 只读连接）。这是 sidecar【第一次接入读路径】。
// 只负责在 record_field_index / records 上把 compile.ts 的物理计划跑成：
//   - 物理过滤后的有序候选 recordId 集合（+ 精确计数）；
//   - 物理数字/日期/勾选字段的表尾聚合；
//   - singleSelect/checkbox 的分桶（选项顺序/空白桶在应用层重排，SQL 只分桶）；
//   - EXPLAIN QUERY PLAN（供测试断言命中索引、无全表 SCAN）。
// 不算任何 cell、不 hydrate：计算字段/残余过滤/搜索/文本排序一律回 recordService 内存口径。
//
// 安全：表 id/字段 id/值全部 ? 绑定；SQL 片段仅来自 compile.ts（固定白名单模板），
// 不接受外部传入的裸 SQL。连接只读打开，与 S2 raw 网关一致，WAL 下不阻塞写者。

import type Database from "better-sqlite3";
import type { SqlBindValue } from "../../db/rawRead.js";
import type { SortJoin } from "./compile.js";

export interface PhysicalFilter {
  /** compile.ts 产出的 WHERE 片段（别名 r），不含前导 AND；null=无物理谓词。 */
  filterSql: string | null;
  filterParams: SqlBindValue[];
}

export interface CandidateQuery extends PhysicalFilter {
  tableId: string;
  sortJoins: SortJoin[] | null;
}

export interface PhysicalAggRequest extends PhysicalFilter {
  tableId: string;
  fieldId: string;
  funcs: Array<"count" | "countEmpty" | "countFilled" | "percentEmpty" | "percentFilled"
    | "sum" | "avg" | "min" | "max">;
}

export interface GroupBucketRequest extends PhysicalFilter {
  tableId: string;
  fieldId: string;
  /** "singleSelect" → valueText 分桶；"checkbox" → valueNum 分桶。 */
  kind: "singleSelect" | "checkbox";
}

export interface GroupBucket {
  key: string;
  recordIds: string[];
}

export interface SidecarQuerier {
  /** 物理过滤命中的活记录数（无 filter 时即表内活行数）。 */
  countPhysical(q: PhysicalFilter & { tableId: string }): number;
  /** 物理过滤 + 物理排序后的有序候选 recordId（tie-break createdAt,id 升序）。 */
  physicalOrderedIds(q: CandidateQuery): string[];
  /** 物理字段表尾聚合（percent* 由 count/empty/filled 推导）。 */
  physicalAggregates(req: PhysicalAggRequest): Record<string, number | null>;
  /** singleSelect/checkbox 分桶（不在 SQL 排序，顺序交应用层）。 */
  physicalGroupBuckets(req: GroupBucketRequest): GroupBucket[];
  /**
   * 数值排序洁净度：候选集中这些 valueNum 排序字段是否【不存在】非空但转不成数的脏值
   *（isNull=0 AND valueNum IS NULL，如 number 列存 "abc"）。存在脏值时内存 sortRows 会退化为
   *  文本比较而非排末尾，SQL 无法逐值复现 zh-CN numeric，编排层须整体回退内存排序。
   *  checkbox 恒 0/1 可不查（调用方对 checkbox 字段无需传入）。
   */
  sortNumericClean(q: PhysicalFilter & { tableId: string; fieldIds: string[] }): boolean;
  /** EXPLAIN QUERY PLAN（供测试断言索引命中 / 无全表 SCAN）。 */
  explain(q: CandidateQuery): string[];
}

function liveWhere(filterSql: string | null): string {
  return `r."tableId"=? AND r."deletedAt" IS NULL${filterSql ? ` AND ${filterSql}` : ""}`;
}

function sortJoinSql(sortJoins: SortJoin[] | null): { sql: string; params: SqlBindValue[] } {
  if (!sortJoins || sortJoins.length === 0) return { sql: "", params: [] };
  const params: SqlBindValue[] = [];
  const parts = sortJoins.map((s) => {
    params.push(s.fieldId); // join 内 tableId 已在外层；此处仅按 fieldId + recordId 关联
    return (
      `LEFT JOIN "record_field_index" ${s.alias} ` +
      `ON ${s.alias}."recordId"=r."id" AND ${s.alias}."tableId"=r."tableId" AND ${s.alias}."fieldId"=?`
    );
  });
  return { sql: parts.join(" "), params };
}

function orderBySql(sortJoins: SortJoin[] | null): string {
  if (!sortJoins || sortJoins.length === 0) {
    return `ORDER BY r."createdAt" ASC, r."id" ASC`;
  }
  // 空值（valueNum IS NULL，含 isNull=1 与非空但转不出数）恒排后；随后按方向排；
  // 末尾固定 createdAt,id 升序 tie-break（与 sortRows 的稳定输入序一致）。
  const terms = sortJoins.map((s) => {
    const dir = s.direction === "desc" ? "DESC" : "ASC";
    return `(${s.alias}."valueNum" IS NULL) ASC, ${s.alias}."valueNum" ${dir}`;
  });
  terms.push(`r."createdAt" ASC`, `r."id" ASC`);
  return `ORDER BY ${terms.join(", ")}`;
}

/**
 * valueNum 族排序字段为标量（每记录每字段仅 1 行 rfi），LEFT JOIN 不会产生重复行；
 * 多排序夹计算字段时 compile.ts 已整体回退内存，故这里 joins 全部 1:1。
 */
export function createSidecarQuerier(db: Database.Database): SidecarQuerier {
  function countPhysical(q: PhysicalFilter & { tableId: string }): number {
    const row = db
      .prepare(`SELECT count(*) AS n FROM records r WHERE ${liveWhere(q.filterSql)}`)
      .get(q.tableId, ...q.filterParams) as { n: number };
    return Number(row.n);
  }

  function physicalOrderedIds(q: CandidateQuery): string[] {
    const join = sortJoinSql(q.sortJoins);
    const sql =
      `SELECT r."id" AS id FROM records r ${join.sql} WHERE ${liveWhere(q.filterSql)} ` +
      `${orderBySql(q.sortJoins)}`;
    // 占位符出现顺序：JOIN ON fieldId（join.params）→ WHERE tableId → 过滤参数。
    const rows = db
      .prepare(sql)
      .all(...join.params, q.tableId, ...q.filterParams) as { id: string }[];
    return rows.map((r) => r.id);
  }

  function physicalAggregates(req: PhysicalAggRequest): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    // count/countEmpty/countFilled 与 sidecar 行对齐：候选记录 × 该字段 rfi 行（标量 1 行）。
    // 对被过滤候选集，用 EXISTS 关联 rfi 取该字段值；空字段 isNull=1（仍有一行）。
    const base =
      `FROM records r LEFT JOIN "record_field_index" a ` +
      `ON a."recordId"=r."id" AND a."tableId"=r."tableId" AND a."fieldId"=? ` +
      `WHERE ${liveWhere(req.filterSql)}`;
    const bind: SqlBindValue[] = [req.fieldId, req.tableId, ...req.filterParams];

    const stat = db
      .prepare(
        `SELECT ` +
          `count(*) AS total, ` +
          `sum(CASE WHEN a."isNull"=1 THEN 1 ELSE 0 END) AS empty, ` +
          `sum(CASE WHEN a."isNull"=0 AND a."valueNum" IS NOT NULL THEN 1 ELSE 0 END) AS numfilled, ` +
          `sum(CASE WHEN a."isNull"=0 THEN a."valueNum" ELSE NULL END) AS sum, ` +
          `avg(CASE WHEN a."isNull"=0 AND a."valueNum" IS NOT NULL THEN a."valueNum" ELSE NULL END) AS avg, ` +
          `min(CASE WHEN a."isNull"=0 THEN a."valueNum" ELSE NULL END) AS min, ` +
          `max(CASE WHEN a."isNull"=0 THEN a."valueNum" ELSE NULL END) AS max ` +
          base,
      )
      .get(...bind) as Record<string, number | null>;

    const total = Number(stat.total ?? 0);
    const empty = Number(stat.empty ?? 0);
    const filled = total - empty;
    for (const fn of req.funcs) {
      switch (fn) {
        case "count": out[fn] = total; break;
        case "countEmpty": out[fn] = empty; break;
        case "countFilled": out[fn] = filled; break;
        case "percentEmpty": out[fn] = total === 0 ? null : (empty / total) * 100; break;
        case "percentFilled": out[fn] = total === 0 ? null : (filled / total) * 100; break;
        case "sum":
        case "avg":
        case "min":
        case "max":
          out[fn] = stat[fn] === null || stat[fn] === undefined ? null : Number(stat[fn]);
          // min/max 仅在至少一个非空数值时有效；sum 在全空时 SQL 返回 null。
          if (fn === "min" || fn === "max") out[fn] = Number(stat.numfilled ?? 0) > 0 ? Number(stat[fn]) : null;
          if (fn === "sum" && Number(stat.numfilled ?? 0) === 0) out[fn] = null;
          break;
      }
    }
    return out;
  }

  function physicalGroupBuckets(req: GroupBucketRequest): GroupBucket[] {
    // 只分桶不排序：选项顺序/颜色/空白桶最后由应用层 group.ts 口径重排。
    // 空值（isNull=1）归到 key=""（应用层映射 __empty__）。
    const keyExpr = req.kind === "checkbox"
      ? `CASE WHEN a."isNull"=1 THEN NULL ELSE CAST(a."valueNum" AS INTEGER) END`
      : `CASE WHEN a."isNull"=1 THEN NULL ELSE a."valueText" END`;
    const sql =
      `SELECT r."id" AS rid, ${keyExpr} AS bucket FROM records r ` +
      `JOIN "record_field_index" a ON a."recordId"=r."id" AND a."tableId"=r."tableId" AND a."fieldId"=? ` +
      `WHERE ${liveWhere(req.filterSql)} ORDER BY r."createdAt" ASC, r."id" ASC`;
    const rows = db
      .prepare(sql)
      .all(req.fieldId, req.tableId, ...req.filterParams) as { rid: string; bucket: string | number | null }[];
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const key = row.bucket === null ? "" : String(row.bucket);
      const arr = map.get(key);
      if (arr) arr.push(row.rid);
      else map.set(key, [row.rid]);
    }
    return [...map.entries()].map(([key, recordIds]) => ({ key, recordIds }));
  }

  function sortNumericClean(q: PhysicalFilter & { tableId: string; fieldIds: string[] }): boolean {
    if (q.fieldIds.length === 0) return true;
    const inList = q.fieldIds.map(() => "?").join(",");
    // 候选集（同样的活行 + 物理过滤）内，任一排序字段出现 isNull=0 且 valueNum IS NULL
    // 的脏行即判不洁。EXISTS 把过滤条件复用一遍，避免漏检被过滤掉的行。
    const sql =
      `SELECT count(*) AS n FROM "record_field_index" x WHERE x."tableId"=? ` +
      `AND x."fieldId" IN (${inList}) AND x."isNull"=0 AND x."valueNum" IS NULL ` +
      `AND EXISTS(SELECT 1 FROM records r WHERE r."id"=x."recordId" AND ${liveWhere(q.filterSql)})`;
    const row = db
      .prepare(sql)
      .get(q.tableId, ...q.fieldIds, q.tableId, ...q.filterParams) as { n: number };
    return Number(row.n) === 0;
  }

  function explain(q: CandidateQuery): string[] {
    const join = sortJoinSql(q.sortJoins);
    const sql =
      `SELECT r."id" AS id FROM records r ${join.sql} WHERE ${liveWhere(q.filterSql)} ` +
      `${orderBySql(q.sortJoins)}`;
    const rows = db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...join.params, q.tableId, ...q.filterParams) as { detail: string }[];
    return rows.map((r) => r.detail);
  }

  return {
    countPhysical,
    physicalOrderedIds,
    physicalAggregates,
    physicalGroupBuckets,
    sortNumericClean,
    explain,
  };
}

