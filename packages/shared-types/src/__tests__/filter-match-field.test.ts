// packages/shared-types/src/__tests__/filter-match-field.test.ts
// 筛选条件「匹配字段」（valueType="field"）：比较值来自本表另一字段（getSelf），
// 用于关联抓取/默认值 lookup 时「目标表字段 = 本表字段」的相等/比较匹配。

import { describe, it, expect } from "vitest";
import { evalFilter, type RawValue } from "../filter.js";
import type { FilterNode } from "../filters.js";

const cond = (over: Record<string, unknown>): FilterNode =>
  ({ kind: "condition", fieldId: "t_amount", op: "eq", value: "", ...over }) as FilterNode;

describe("evalFilter 匹配字段（valueType=field）", () => {
  it("eq：目标字段值 = 本表字段值 → true", () => {
    const node = cond({ op: "eq", valueType: "field", valueFieldId: "s_threshold" });
    // 目标表记录 t_amount = 100；本表 s_threshold = 100
    const ok = evalFilter(
      node,
      (fid) => (fid === "t_amount" ? 100 : null) as RawValue,
      (fid) => (fid === "s_threshold" ? 100 : null) as RawValue,
    );
    expect(ok).toBe(true);
  });

  it("eq：数值不等 → false", () => {
    const node = cond({ op: "eq", valueType: "field", valueFieldId: "s_threshold" });
    const ok = evalFilter(
      node,
      (fid) => (fid === "t_amount" ? 50 : null) as RawValue,
      (fid) => (fid === "s_threshold" ? 100 : null) as RawValue,
    );
    expect(ok).toBe(false);
  });

  it("gt：目标字段 > 本表字段", () => {
    const node = cond({ op: "gt", valueType: "field", valueFieldId: "s_min" });
    expect(
      evalFilter(
        node,
        (fid) => (fid === "t_amount" ? 200 : null) as RawValue,
        (fid) => (fid === "s_min" ? 150 : null) as RawValue,
      ),
    ).toBe(true);
    expect(
      evalFilter(
        node,
        (fid) => (fid === "t_amount" ? 100 : null) as RawValue,
        (fid) => (fid === "s_min" ? 150 : null) as RawValue,
      ),
    ).toBe(false);
  });

  it("is（文本相等）：目标状态 = 本表状态", () => {
    const node = cond({ fieldId: "t_level", op: "is", valueType: "field", valueFieldId: "s_level" });
    expect(
      evalFilter(
        node,
        (fid) => (fid === "t_level" ? "vip" : null) as RawValue,
        (fid) => (fid === "s_level" ? "vip" : null) as RawValue,
      ),
    ).toBe(true);
    expect(
      evalFilter(
        node,
        (fid) => (fid === "t_level" ? "normal" : null) as RawValue,
        (fid) => (fid === "s_level" ? "vip" : null) as RawValue,
      ),
    ).toBe(false);
  });

  it("缺省 getSelf 时回退到 get（同表自比较）：同名字段比较自身恒等", () => {
    const node = cond({ fieldId: "amount", op: "eq", valueType: "field", valueFieldId: "amount" });
    expect(
      evalFilter(node, (fid) => (fid === "amount" ? 42 : null) as RawValue),
    ).toBe(true);
  });

  it("contains：数组目标值包含本表字段文本", () => {
    const node = cond({ fieldId: "t_tags", op: "contains", valueType: "field", valueFieldId: "s_kw" });
    expect(
      evalFilter(
        node,
        (fid) => (fid === "t_tags" ? ["a", "VIP客户", "b"] : null) as RawValue,
        (fid) => (fid === "s_kw" ? "VIP" : null) as RawValue,
      ),
    ).toBe(true);
  });

  it("and/or 组内匹配字段递归求值", () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        cond({ fieldId: "t_level", op: "is", valueType: "field", valueFieldId: "s_level" }),
        cond({ fieldId: "t_amount", op: "gte", valueType: "field", valueFieldId: "s_min" }),
      ],
    };
    const get = (fid: string): RawValue =>
      (({ t_level: "vip", t_amount: 300 } as Record<string, RawValue>)[fid] ?? null);
    const getSelf = (fid: string): RawValue =>
      (({ s_level: "vip", s_min: 100 } as Record<string, RawValue>)[fid] ?? null);
    expect(evalFilter(node, get, getSelf)).toBe(true);
  });

  it("本表匹配字段为空（null）时比较不成立", () => {
    const node = cond({ op: "eq", valueType: "field", valueFieldId: "s_threshold" });
    const ok = evalFilter(
      node,
      (fid) => (fid === "t_amount" ? 100 : null) as RawValue,
      () => null as RawValue,
    );
    expect(ok).toBe(false);
  });
});
