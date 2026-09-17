// M6/S4 filter/sort 白名单映射（纯函数）：MCP 入参 -> M1 queryPlan 的 FilterNode / SortSpec。
//
// 只接受 schemas.ts 里声明的算子白名单（zod4 enum 已拦非法值），本文件再做一次**纵深防御**：
// 非白名单算子一律抛 InvalidParamsError，绝不透传到 compile（禁任意 SQL/公式）。

import type { FilterNode, SortSpec } from "@gx/shared-types";

/** 允许的算子（与 schemas.ts FILTER_OPS 同集合；此处独立声明避免 zod4 模块被非 schema 文件取值）。 */
const ALLOWED_OPS = new Set([
  "is", "isNot", "contains", "notContains", "isEmpty", "isNotEmpty",
  "gte", "lte", "gt", "lt", "isAnyOf", "checked", "notChecked",
]);

export class InvalidParamsError extends Error {
  readonly code = "INVALID_PARAMS";
  constructor(message: string) {
    super(message);
    this.name = "InvalidParamsError";
  }
}

export interface FilterArg { fieldId: string; op: string; value?: string }

/** 多条件 -> AND 组合；空 -> null（不加过滤）。 */
export function buildFilterNode(args: FilterArg[] | undefined): FilterNode | null {
  if (!args || args.length === 0) return null;
  const conditions: FilterNode[] = args.map((a) => {
    if (!a || typeof a.fieldId !== "string" || a.fieldId === "") {
      throw new InvalidParamsError("filter.fieldId 必填");
    }
    if (!ALLOWED_OPS.has(a.op)) {
      throw new InvalidParamsError(`filter.op 不支持：${String(a.op)}`);
    }
    return { kind: "condition", fieldId: a.fieldId, op: a.op, value: a.value ?? "" } as unknown as FilterNode;
  });
  return conditions.length === 1
    ? conditions[0]!
    : ({ kind: "and", children: conditions } as unknown as FilterNode);
}

/** 排序：两键都给才生效；方向非法抛错（zod4 已拦，此处纵深防御）。 */
export function buildSortSpec(fieldId: string | undefined, direction: "asc" | "desc" | undefined): SortSpec[] | null {
  if (!fieldId && !direction) return null;
  if (!fieldId || !direction) throw new InvalidParamsError("排序需同时提供 sortFieldId 与 sortDirection");
  if (direction !== "asc" && direction !== "desc") throw new InvalidParamsError(`sortDirection 非法：${String(direction)}`);
  return [{ fieldId, direction }];
}
