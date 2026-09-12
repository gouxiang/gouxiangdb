// apps/api/src/domain/sort.ts
// 排序引擎（v1 RecordRepository 的 ORDER BY 语义 TS 同构）
//
// v1 排序在 SQL 层做；v2 内存排序。规则：
//   1. 空值永远排在后面（无论 asc/desc）—— 对齐 v1/NocoDB 直觉
//   2. 数值字段按数值比较；日期按时间戳；其余按本地化字符串
//   3. 多选/关联按「文本化后的首个元素」

import type { SortSpec } from "@gx/shared-types";
import { toComparableText } from "./filter.js";

export type SortableRow = {
  id: string;
  get: (fieldId: string) => unknown;
};

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v === "";
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

function parseDate(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

function numeric(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === null || v === undefined || v === "") return null;
  const maybe = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(maybe) ? maybe : null;
}

function compareByType(a: unknown, b: unknown, type: string): number {
  // 日期类
  if (type === "date" || type === "datetime" || type === "createdTime" || type === "lastModifiedTime") {
    const ta = parseDate(a);
    const tb = parseDate(b);
    if (ta !== null && tb !== null) return ta - tb;
    return toComparableText(a).localeCompare(toComparableText(b), "zh-CN");
  }
  // 数值类
  if (
    type === "number" ||
    type === "currency" ||
    type === "percent" ||
    type === "duration" ||
    type === "rating" ||
    type === "autoNumber" ||
    type === "count" ||
    type === "rollup"
  ) {
    const na = numeric(a);
    const nb = numeric(b);
    if (na !== null && nb !== null) return na - nb;
    return toComparableText(a).localeCompare(toComparableText(b), "zh-CN");
  }
  // 布尔
  if (type === "checkbox") {
    const ba = a === true || a === 1 || String(a) === "true" ? 1 : 0;
    const bb = b === true || b === 1 || String(b) === "true" ? 1 : 0;
    return ba - bb;
  }
  // 其余按本地化字符串
  return toComparableText(a).localeCompare(toComparableText(b), "zh-CN", { numeric: true });
}

/**
 * 按 SortSpec[] 排序。fieldTypes 提供字段类型以决定比较策略。
 * 返回新的数组（不修改入参）。
 */
export function sortRows<T extends SortableRow>(
  rows: T[],
  sorts: SortSpec[],
  fieldTypes: Record<string, string>,
): T[] {
  if (sorts.length === 0) return rows;
  const out = [...rows];
  out.sort((ra, rb) => {
    for (const s of sorts) {
      const type = fieldTypes[s.fieldId] ?? "singleLineText";
      const a = ra.get(s.fieldId);
      const b = rb.get(s.fieldId);
      const ea = isEmpty(a);
      const eb = isEmpty(b);
      // 空值恒排后面
      if (ea && eb) continue;
      if (ea) return 1;
      if (eb) return -1;
      const c = compareByType(a, b, type);
      if (c !== 0) return s.direction === "asc" ? c : -c;
    }
    return 0;
  });
  return out;
}
