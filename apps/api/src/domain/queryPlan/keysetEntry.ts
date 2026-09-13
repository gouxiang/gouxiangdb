// apps/api/src/domain/queryPlan/keysetEntry.ts
// M1/S7：recordService → keyset 分页的唯一入口与 shadow 对拍。
// 由 recordService 在 GX_M1_SIDECAR_READ=on 时按需动态 import（默认 off 不牵入本模块）。
// keyset 三档编排见 paginate.ts；本文件只做 QueryOptions 映射、客户端错误识别与差异记录。

import type { QueryOptions, QueryResult } from "../recordService.js";
import { getSidecarQuerier } from "./connection.js";
import { runKeysetPaging } from "./paginate.js";

/** 执行一次 keyset 分页查询并映射回 QueryResult（additive 三键仅本路径出现）。 */
export async function runKeysetQuery(opts: QueryOptions): Promise<QueryResult> {
  const r = await runKeysetPaging(getSidecarQuerier(), {
    tableId: opts.tableId,
    fields: opts.fields,
    config: opts.config,
    search: (opts.search ?? opts.config.search ?? "").trim(),
    limit: opts.limit ?? 200,
    offset: opts.offset ?? 0,
    cursor: opts.cursor ?? null,
  });
  return {
    records: r.records,
    total: r.total,
    filteredTotal: r.filteredTotal,
    groups: r.groups,
    aggregations: r.aggregations,
    nextCursor: r.nextCursor,
    hasMore: r.hasMore,
    degraded: r.degraded,
  };
}

/**
 * 400 类客户端错误（坏游标 / offset 超窗）：上层捕获后必须转 400 透传，
 * 【不得】回退旧路径（回退会静默返回错误的一页而非提示客户端）。
 */
export function isKeysetClientError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "InvalidCursorError" || e.name === "OffsetWindowError")
  );
}

/**
 * shadow 对拍（GX_M1_KEYSET=shadow）。旧路径（planner offset slice）结果照返回，
 * 本函数只记录差异、绝不抛出。
 * 可逐值对拍的请求：无游标（首页或带 offset 的老客户端请求）——两路径表达同一窗口，
 * recordId 序列/total/filteredTotal/aggregations 必须全等。
 * 带 cursor 的翻页请求旧路径无对应概念（会忽略 cursor 返回首页），故只核对计数口径，
 * 序列等价由「翻 10 页拼接 == 全量有序集合」专项测试保证。
 */
export function logKeysetShadowDiff(
  opts: QueryOptions,
  legacy: QueryResult,
  keyset: QueryResult,
  mode: string,
): void {
  const diffs: string[] = [];
  if (legacy.total !== keyset.total) diffs.push(`total ${legacy.total}!=${keyset.total}`);
  if (legacy.filteredTotal !== keyset.filteredTotal) {
    diffs.push(`filteredTotal ${legacy.filteredTotal}!=${keyset.filteredTotal}`);
  }
  if (!opts.cursor) {
    const lids = legacy.records.map((r) => r.id);
    const kids = keyset.records.map((r) => r.id);
    if (lids.length !== kids.length || lids.some((id, i) => id !== kids[i])) {
      const first = lids.findIndex((id, i) => id !== kids[i]);
      diffs.push(`recordId 序列分歧 firstAt=${first} legacyN=${lids.length} keysetN=${kids.length}`);
    }
  }
  const la = legacy.aggregations ?? {};
  const ka = keyset.aggregations ?? {};
  for (const fid of new Set([...Object.keys(la), ...Object.keys(ka)])) {
    if (Math.abs((la[fid] ?? NaN) - (ka[fid] ?? NaN)) > 1e-6) {
      diffs.push(`agg[${fid}] ${la[fid]}!=${ka[fid]}`);
    }
  }
  if (diffs.length > 0) {
    console.warn(`[queryPlan][keyset-shadow] 差异 table=${opts.tableId} mode=${mode}: ${diffs.join("; ")}`);
  }
}
