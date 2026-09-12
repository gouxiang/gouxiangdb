// packages/shared-types/src/__tests__/filter-date-multiselect.test.ts
// 日期/多选字段筛选回归（D-1 日期 gt/lt 曾因 Number('YYYY-MM-DD')=NaN 恒 false；
// D-2 多选存 option.id，筛选值须用 id 才能命中）。

import { describe, it, expect } from "vitest";
import { evalFilter, type RawValue } from "../filter.js";
import type { FilterNode } from "../filters.js";

const cond = (over: Record<string, unknown>): FilterNode =>
  ({ kind: "condition", fieldId: "d", op: "gt", value: "", ...over }) as FilterNode;

const get = (v: RawValue) => (_fid: string) => v;

describe("evalFilter 日期字段", () => {
  it("date 'YYYY-MM-DD' gt 比较生效（不再恒 false）", () => {
    const node = cond({ op: "gt", value: "2026-01-01" });
    expect(evalFilter(node, get("2026-09-11"))).toBe(true);
    expect(evalFilter(node, get("2025-12-31"))).toBe(false);
  });

  it("date gte/lte 边界与方向正确", () => {
    expect(evalFilter(cond({ op: "gte", value: "2026-09-11" }), get("2026-09-11"))).toBe(true);
    expect(evalFilter(cond({ op: "lte", value: "2026-09-11" }), get("2026-09-11"))).toBe(true);
    expect(evalFilter(cond({ op: "lt", value: "2026-09-11" }), get("2026-09-10"))).toBe(true);
    expect(evalFilter(cond({ op: "lt", value: "2026-09-11" }), get("2026-09-12"))).toBe(false);
  });

  it("datetime ISO 串按时间戳比较", () => {
    const node = cond({ op: "gt", value: "2026-09-11T00:00:00.000Z" });
    expect(evalFilter(node, get("2026-09-11T12:00:00.000Z"))).toBe(true);
  });

  it("空/非日期值参与比较返回 false（不报错）", () => {
    const node = cond({ op: "gt", value: "2026-01-01" });
    expect(evalFilter(node, get(null))).toBe(false);
    expect(evalFilter(node, get(""))).toBe(false);
    expect(evalFilter(node, get("abc"))).toBe(false);
  });
});

describe("evalFilter 多选字段（存 option.id 数组）", () => {
  it("contains 用 option.id 命中", () => {
    // 单元格存 id 数组；筛选字面量同样为 id（FilterPanel 已改为 value=o.id）
    const node = cond({ fieldId: "m", op: "contains", value: "opt_1" });
    expect(evalFilter(node, get(["opt_1", "opt_2"]))).toBe(true);
    expect(evalFilter(node, get(["opt_2"]))).toBe(false);
  });

  it("isAnyOf 任一 id 命中", () => {
    const node = cond({ fieldId: "m", op: "isAnyOf", value: "opt_1,opt_3" });
    expect(evalFilter(node, get(["opt_3"]))).toBe(true);
    expect(evalFilter(node, get(["opt_9"]))).toBe(false);
  });
});
