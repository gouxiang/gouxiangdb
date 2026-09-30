// P1-S8b-2 行级可见行条件（RowConditions）读求值纯函数层。
//
// 纯域：不 import Hono/db/Prisma；与 fieldMask「并集最宽」对称的多来源合并：
//   - 命中的 r 来源中任一来源 rowConditions===null（无条件=宽）-> rowFilter=null（整表不过滤）；
//     creator/owner 兜底的 syntheticWidePolicy 不带条件，其命中即宽。
//   - 所有 r 来源都带条件时，各来源 filter 用 OR 合并（满足任一来源条件即可见）。
// 列表/详情/写入口共用本文件同一份口径，杜绝三出口漂移。

import type { FilterNode } from "@gx/shared-types";
import { evalFilter, type RawValue } from "../filter.js";
import type { ScopedPolicy } from "./types.js";

/** 求值所需的字段最小投影。 */
interface RowFieldDef {
  id: string;
  type: string;
}

/** 求值所需的记录最小投影（hydrate 后单行）。 */
interface RowRecord {
  fields: Record<string, unknown>;
  createdBy?: string;
  updatedBy?: string;
}

/**
 * 合并命中 r 来源的行级条件：
 *   - 无 r 来源 -> null（调用方按表级不可见另行处理）；
 *   - 任一来源无条件 -> null（宽，整表不做行级过滤）；
 *   - 单一来源直接取其 filter；多个来源 OR 合并。
 */
export function combineRowConditions(rPolicies: readonly ScopedPolicy[]): FilterNode | null {
  if (rPolicies.length === 0) return null;
  if (rPolicies.some((p) => p.rowConditions === null)) return null;
  const filters = rPolicies.map((p) => p.rowConditions!.filter);
  if (filters.length === 1) return filters[0]!;
  return { kind: "or", children: filters };
}

/**
 * 对单行求行级过滤器（与列表 applyViewQuery 同口径）：
 * rowFilter===null 恒可见；否则按字段类型把 actor 字段解析回 userId 后交 evalFilter。
 */
export function evaluateRowFilter(
  rowFilter: FilterNode | null,
  rec: RowRecord,
  fields: readonly RowFieldDef[],
  currentUserId: string | null,
): boolean {
  if (rowFilter === null) return true;
  const typeById = new Map(fields.map((f) => [f.id, f.type]));
  return evalFilter(
    rowFilter,
    (fid) => rec.fields[fid] as RawValue,
    undefined,
    {
      vars: { currentUserId: currentUserId ?? null },
      getActorId: (fid) => {
        const t = typeById.get(fid);
        if (t === "createdBy") return rec.createdBy as RawValue;
        if (t === "lastModifiedBy") return rec.updatedBy as RawValue;
        return rec.fields[fid] as RawValue;
      },
    },
  );
}

/** 两个过滤器 AND 组合：null 取另一个；二者皆有 -> and 节点。 */
export function andFilters(a: FilterNode | null, b: FilterNode | null): FilterNode | null {
  if (a === null) return b;
  if (b === null) return a;
  return { kind: "and", children: [a, b] };
}
