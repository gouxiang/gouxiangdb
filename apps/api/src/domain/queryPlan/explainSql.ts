// apps/api/src/domain/queryPlan/explainSql.ts
// countPhysical / physicalKeysetOnCreatedAt 的 countPlan JOIN 快速路径 SQL 与其 EXPLAIN 绑定，
// 抽成独立模块让执行器（sidecarQuery.ts）与真库形态测试共用同一事实源，避免两处拼串漂移。
// 这里只产 SQL 文本/绑定并对给定连接跑 EXPLAIN，不持有连接、不做实际取数。
// 类型用自包含最小结构（仅依赖 compileCount 的 CountPlan），避免与 sidecarQuery 循环导入。

import type Database from "better-sqlite3";
import type { SqlBindValue } from "../../db/rawRead.js";
import type { CountPlan } from "./compileCount.js";

/** 与 sidecarQuery.PhysicalFilter 结构兼容的最小输入。 */
export interface CountSqlInput {
  tableId: string;
  filterSql: string | null;
  filterParams: SqlBindValue[];
  countPlan?: CountPlan | null;
}

/** 与 sidecarQuery.KeysetPageArgs 结构兼容的最小输入。 */
export interface KeysetSqlInput extends CountSqlInput {
  cursor: { createdAt: number; id: string } | null;
  limit: number;
}

function liveWhere(filterSql: string | null): string {
  return `r."tableId"=? AND r."deletedAt" IS NULL${filterSql ? ` AND ${filterSql}` : ""}`;
}

function cursorClause(q: KeysetSqlInput): string {
  return q.cursor
    ? `AND (r."createdAt" > ? OR (r."createdAt" = ? AND r."id" > ?))`
    : "";
}

/** countPhysical 的完整 SQL（有 countPlan 走 JOIN 快速路径，否则走 filterSql 相关 EXISTS）。 */
export function countSql(q: CountSqlInput): string {
  if (q.countPlan) return countJoinSql(q);
  return `SELECT count(*) AS n FROM records r WHERE ${liveWhere(q.filterSql)}`;
}

/** countPhysical 完整绑定（与 countSql 占位符同序）。 */
export function countAllBinds(q: CountSqlInput): SqlBindValue[] {
  return q.countPlan ? countBinds(q) : [q.tableId, ...q.filterParams];
}

/** physicalKeysetOnCreatedAt 的完整 SQL（有 countPlan 走 JOIN，否则 records 驱动 + filterSql）。 */
export function keysetSql(q: KeysetSqlInput): string {
  if (q.countPlan) return keysetJoinSql(q);
  return (
    `SELECT r."id" AS id, r."createdAt" AS createdAt FROM records r ` +
    `WHERE ${liveWhere(q.filterSql)} ${cursorClause(q)} ORDER BY r."createdAt" ASC, r."id" ASC LIMIT ?`
  );
}

/** physicalKeysetOnCreatedAt 完整绑定（JOIN 或回退口径，与 keysetSql 占位符同序）。 */
export function keysetAllBinds(q: KeysetSqlInput, limit: number): SqlBindValue[] {
  if (!q.countPlan) {
    const bind: SqlBindValue[] = [q.tableId, ...q.filterParams];
    if (q.cursor) bind.push(q.cursor.createdAt, q.cursor.createdAt, q.cursor.id);
    bind.push(limit);
    return bind;
  }
  return keysetBinds(q, limit);
}

/** countPhysical 的 countPlan JOIN 快速路径完整 SQL（调用前必须 countPlan 非空）。 */
export function countJoinSql(q: CountSqlInput): string {
  return (
    `SELECT count(*) AS n FROM records r ${q.countPlan!.joins} ` +
    `WHERE r."tableId"=? AND r."deletedAt" IS NULL`
  );
}

/** physicalKeysetOnCreatedAt 的 countPlan JOIN 取页完整 SQL（cursor 以占位符形态给出）。 */
export function keysetJoinSql(q: KeysetSqlInput): string {
  return (
    `SELECT r."id" AS id, r."createdAt" AS createdAt FROM records r ${q.countPlan!.joins} ` +
    `WHERE r."tableId"=? AND r."deletedAt" IS NULL ${cursorClause(q)} ` +
    `ORDER BY r."createdAt" ASC, r."id" ASC LIMIT ?`
  );
}

/** countPlan JOIN 计数路径的绑定（JOIN 参数在前，records.tableId 在末）。 */
export function countBinds(q: CountSqlInput): SqlBindValue[] {
  return [...(q.countPlan?.joinParams ?? []), q.tableId];
}

/** keyset 取页路径的绑定（JOIN 参数→tableId→可选游标三参→limit）。 */
export function keysetBinds(q: KeysetSqlInput, limit: number): SqlBindValue[] {
  const bind: SqlBindValue[] = [...(q.countPlan?.joinParams ?? []), q.tableId];
  if (q.cursor) bind.push(q.cursor.createdAt, q.cursor.createdAt, q.cursor.id);
  bind.push(limit);
  return bind;
}

function run(db: Database.Database, sql: string, params: SqlBindValue[]): string[] {
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params) as { detail: string }[];
  return rows.map((r) => r.detail);
}

/** COUNT 路径的 EXPLAIN 计划行（countPlan 为空时回退 filterSql 口径）。 */
export function explainCountSql(db: Database.Database, q: CountSqlInput): string[] {
  return run(db, countSql(q), countAllBinds(q));
}

/** keyset 取页路径的 EXPLAIN 计划行（默认首页 cursor=null）。 */
export function explainKeysetSql(db: Database.Database, q: KeysetSqlInput): string[] {
  return run(db, keysetSql(q), keysetAllBinds(q, q.limit + 1));
}
