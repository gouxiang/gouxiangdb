// apps/api/src/domain/aggregate.ts
// 列聚合（v1 Features/Grid/AggregationRow.swift TS 同构）

import type { AggFunc } from "@gx/shared-types";
import { isEmptyValue } from "./filter.js";

type AggValue = unknown;

function toNum(v: AggValue): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 对一列的若干值做聚合。返回 null 表示该列无可聚合结果。 */
export function aggregate(func: AggFunc, values: AggValue[]): number | null {
  const nums = values.map(toNum).filter((x): x is number => x !== null);
  const total = values.length;

  switch (func) {
    case "count":
      return total;
    case "countEmpty":
      return values.filter(isEmptyValue).length;
    case "countFilled":
      return values.filter((v) => !isEmptyValue(v)).length;
    case "percentEmpty":
      return total === 0 ? null : (values.filter(isEmptyValue).length / total) * 100;
    case "percentFilled":
      return total === 0 ? null : (values.filter((v) => !isEmptyValue(v)).length / total) * 100;
    case "sum":
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
    case "avg":
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    case "min":
      return nums.length === 0 ? null : Math.min(...nums);
    case "max":
      return nums.length === 0 ? null : Math.max(...nums);
    default:
      return null;
  }
}

/** 对一整列做多个聚合（用于分组桶 / 表尾） */
export function aggregateAll(
  values: AggValue[],
  funcs: Record<string, AggFunc | null>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [fieldId, f] of Object.entries(funcs)) {
    out[fieldId] = f ? aggregate(f, values) : null;
  }
  return out;
}
