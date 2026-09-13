// M1/S10 计数快速计划单测（无 DB）：rfi JOIN 驱动 COUNT 的形态、绑定顺序与安全放弃条件。
// 与 compile.test 同一份字段目录；JOIN 计数的【数值正确性】由 sidecarQuery/planner parity 真库对拍锁定。

import { describe, expect, it } from "vitest";
import type { FilterNode, SortSpec } from "@gx/shared-types";
import { compilePlan, type PlanField } from "../compile.js";

const fields: PlanField[] = [
  { id: "name", type: "singleLineText", isPrimary: true },
  { id: "email", type: "email" },
  { id: "age", type: "number" },
  { id: "stars", type: "rating" },
  { id: "born", type: "date" },
  { id: "ok", type: "checkbox" },
  { id: "status", type: "singleSelect" },
  { id: "tags", type: "multiSelect" },
  { id: "auto", type: "autoNumber" },
  { id: "calc", type: "formula" },
];

const cond = (fieldId: string, op: string, value = "x"): FilterNode =>
  ({ kind: "condition", fieldId, op, value }) as FilterNode;
const and = (children: FilterNode[]): FilterNode => ({ kind: "and", children });
const or = (children: FilterNode[]): FilterNode => ({ kind: "or", children });

function countOf(node: FilterNode | null) {
  return compilePlan("T1", fields, node, [] as SortSpec[]).countPlan;
}

describe("compileCountPlan rfi JOIN 计数快速路径", () => {
  it("无过滤 → null（调用方走 count(*) 全表活行）", () => {
    expect(countOf(null)).toBeNull();
  });

  it("同字段 range gte+lte → 单个 JOIN，绑定 tableId/fieldId/下界/上界", () => {
    const cp = countOf(and([cond("age", "gte", "10"), cond("age", "lte", "20")]));
    expect(cp).not.toBeNull();
    expect((cp!.joins.match(/JOIN "record_field_index"/g) ?? []).length).toBe(1);
    expect(cp!.joinParams).toEqual(["T1", "age", 10, 20]);
    expect(cp!.joins).toContain("AND");
    // 占位符与绑定同数（JOIN 内 4 个 ?；records.tableId 的 ? 在执行器侧追加）。
    expect((cp!.joins.match(/\?/g) ?? []).length).toBe(4);
  });

  it("不同字段 AND → 两个 JOIN（c0/c1），各绑 tableId/fieldId/值", () => {
    const cp = countOf(and([cond("age", "gt", "10"), cond("stars", "lte", "4")]));
    expect(cp).not.toBeNull();
    expect((cp!.joins.match(/JOIN "record_field_index"/g) ?? []).length).toBe(2);
    expect(cp!.joins).toContain("c0.");
    expect(cp!.joins).toContain("c1.");
    expect(cp!.joinParams).toEqual(["T1", "age", 10, "T1", "stars", 4]);
  });

  it("同字段 OR → 单 JOIN 内 OR 连接（一个 fieldId）", () => {
    const cp = countOf(or([cond("age", "gt", "90"), cond("age", "lt", "5")]));
    expect(cp).not.toBeNull();
    expect((cp!.joins.match(/JOIN "record_field_index"/g) ?? []).length).toBe(1);
    expect(cp!.joins).toContain(" OR ");
    expect(cp!.joinParams).toEqual(["T1", "age", 90, 5]);
  });

  it("日期 range → 单 JOIN 毫秒绑定", () => {
    const cp = countOf(and([cond("born", "gte", "2026-01-01"), cond("born", "lt", "2026-02-01")]));
    expect(cp).not.toBeNull();
    expect(cp!.joinParams).toEqual(["T1", "born", Date.parse("2026-01-01"), Date.parse("2026-02-01")]);
  });

  it("singleSelect is / isAnyOf / checkbox / isEmpty 均可 JOIN 计数", () => {
    expect(countOf(cond("status", "is", "o1"))!.joinParams).toEqual(["T1", "status", "o1"]);
    expect(countOf(cond("status", "isAnyOf", "a,b"))!.joinParams).toEqual(["T1", "status", "a", "b"]);
    expect(countOf(cond("ok", "checked"))!.joinParams).toEqual(["T1", "ok"]);
    expect(countOf(cond("age", "isEmpty"))!.joinParams).toEqual(["T1", "age"]);
  });
});

describe("compileCountPlan 安全放弃（回退相关 EXISTS，计数不变）", () => {
  it("neq / isNot / isNoneOf（NOT 折叠）→ null", () => {
    expect(countOf(cond("age", "neq", "5"))).toBeNull();
    expect(countOf(cond("status", "isNot", "o1"))).toBeNull();
    expect(countOf(cond("tags", "isNoneOf", "a"))).toBeNull();
  });

  it("multiSelect 多行字段 isAnyOf → null（JOIN 会重复计数）", () => {
    expect(countOf(cond("tags", "isAnyOf", "a,b"))).toBeNull();
  });

  it("autoNumber / formula → null", () => {
    expect(countOf(cond("auto", "eq", "1"))).toBeNull();
    expect(countOf(cond("calc", "gt", "1"))).toBeNull();
  });

  it("跨字段 OR → null", () => {
    expect(countOf(or([cond("age", "gt", "1"), cond("stars", "lt", "5")]))).toBeNull();
  });

  it("OR 内混入不可改写叶（formula）→ null", () => {
    expect(countOf(or([cond("age", "gt", "1"), cond("calc", "gt", "2")]))).toBeNull();
  });

  it("AND 内混入 NOT 谓词 → 整体放弃（回退全相关 EXISTS，保证补集计数正确）", () => {
    expect(countOf(and([cond("age", "gte", "10"), cond("age", "neq", "15")]))).toBeNull();
  });

  it("数值字面量转不成数 → null", () => {
    expect(countOf(cond("age", "gt", "abc"))).toBeNull();
  });

  it("valueType=field 跨列比较 → null", () => {
    const node = { kind: "condition", fieldId: "age", op: "eq", value: "", valueType: "field", valueFieldId: "stars" } as unknown as FilterNode;
    expect(countOf(node)).toBeNull();
  });
});
