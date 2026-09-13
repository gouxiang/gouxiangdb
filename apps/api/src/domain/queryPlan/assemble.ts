// apps/api/src/domain/queryPlan/assemble.ts
// 列表结果组装纯函数：groups / 表尾 aggregations。
// 从 recordService.queryRecords 原样抽出（S5 既有逻辑，不改一值），供旧内存路径与
// S6 queryPlan 计划器路径【共用同一份组装代码】，保证两种取数编排下分组/聚合输出零分歧。

import type { AggFunc, GroupBucket, ViewConfig } from "@gx/shared-types";
import type { HydratedRecord, FieldMeta } from "../types.js";
import { computeGroups } from "../group.js";
import { aggregateAll } from "../aggregate.js";

/** 表尾聚合：逐字段按配置的 AggFunc 在过滤后记录上聚合（与 S5 行为一致）。 */
export function assembleAggregations(
  hydrated: HydratedRecord[],
  aggFuncs: Record<string, AggFunc | null>,
): Record<string, number | null> | null {
  if (Object.keys(aggFuncs).length === 0) return null;
  const aggregations: Record<string, number | null> = {};
  for (const [fid, fn] of Object.entries(aggFuncs)) {
    if (!fn) continue;
    aggregations[fid] =
      aggregateAll(hydrated.map((r) => r.fields[fid]), { [fid]: fn })[fid] ?? null;
  }
  return aggregations;
}

/**
 * 分组：在过滤后记录上跑 computeGroups（选项顺序/颜色/空白桶最后/checkbox 顺序全在该函数内）。
 * 返回 null 表示该视图未配置分组或字段缺失（与 S5 queryRecords 行为一致）。
 */
export function assembleGroups(
  hydrated: HydratedRecord[],
  fields: FieldMeta[],
  config: ViewConfig,
): GroupBucket[] | null {
  const groupByFieldId = config.groupByFieldId;
  if (!groupByFieldId) return null;
  const gf = fields.find((f) => f.id === groupByFieldId);
  if (!gf) return null;
  const aggFuncs = config.aggregations ?? {};
  const byId = new Map(hydrated.map((r) => [r.id, r]));
  return computeGroups(
    { recordIds: hydrated.map((r) => r.id), get: (rid, fid) => byId.get(rid)?.fields[fid] },
    { id: gf.id, type: gf.type, options: gf.options ?? undefined },
    (ids) => {
      const out: Record<string, number | null> = {};
      for (const [fid, fn] of Object.entries(aggFuncs)) {
        if (!fn) continue;
        out[fid] = aggregateAll(ids.map((i) => byId.get(i)?.fields[fid]), { [fid]: fn })[fid] ?? null;
      }
      return out;
    },
  );
}
