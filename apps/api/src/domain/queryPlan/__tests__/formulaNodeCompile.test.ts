// queryPlan 对高级筛选（kind:"formula"）的编译/回退契约：
//  - compileNode：formula 永不出 SQL，整节点留 residual；
//  - compilePlan：filtersFullyPhysical=false（必走 B 档内存精修），countPlan=null（计数不快速下推）；
//  - AND 部分下推：物理条件仍出 SQL，formula 同时留 residual（宽口径粗筛不丢、不错计）；
//  - collectFormulaExpressions / filterHasFormulaNode 纯函数。

import { describe, it, expect } from "vitest";
import type { FilterNode } from "@gx/shared-types";
import { compilePlan } from "../compile.js";
import { collectFormulaExpressions, filterHasFormulaNode } from "../formulaEval.js";

const f1 = "f1";
const fields = [{ id: f1, tableId: "t", name: "数量", type: "number" }] as never;
const formulaNode = (expression = "{数量} > 3"): FilterNode => ({ kind: "formula", expression });

describe("collectFormulaExpressions / filterHasFormulaNode", () => {
  it("收集树内公式表达式（去重、保序）", () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        formulaNode("a"),
        { kind: "not", child: formulaNode("b") },
        formulaNode("a"), // 重复
        { kind: "condition", fieldId: f1, op: "gt", value: "1" },
      ],
    };
    expect(collectFormulaExpressions(node)).toEqual(["a", "b"]);
    expect(filterHasFormulaNode(node)).toBe(true);
  });

  it("纯条件树 / null 返回空", () => {
    expect(collectFormulaExpressions(null)).toEqual([]);
    expect(filterHasFormulaNode({ kind: "condition", fieldId: f1, op: "gt", value: "1" })).toBe(false);
  });
});

describe("compilePlan 对 formula 节点", () => {
  it("单 formula：无 SQL、residual 为该节点、非全物理、countPlan=null", () => {
    const plan = compilePlan("t", fields, formulaNode(), null, null, "u1");
    expect(plan.filterSql).toBeNull();
    expect(plan.residual).toEqual(formulaNode());
    expect(plan.filtersFullyPhysical).toBe(false);
    expect(plan.countPlan).toBeNull();
  });

  it("AND(物理条件, formula)：物理条件下推 SQL，formula 留 residual", () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "condition", fieldId: f1, op: "gt", value: "10" },
        formulaNode(),
      ],
    };
    const plan = compilePlan("t", fields, node, null, null, "u1");
    // 物理粗筛仍保留（宽口径超集），但不视为全物理 -> 进入 B 档内存精修
    expect(plan.filterSql).toContain("EXISTS");
    expect(plan.residual).toEqual(formulaNode());
    expect(plan.filtersFullyPhysical).toBe(false);
    expect(plan.countPlan).toBeNull();
  });

  it("OR 含 formula：整 OR 回退 residual，不出 SQL", () => {
    const node: FilterNode = {
      kind: "or",
      children: [
        { kind: "condition", fieldId: f1, op: "gt", value: "10" },
        formulaNode(),
      ],
    };
    const plan = compilePlan("t", fields, node, null, null, "u1");
    expect(plan.filterSql).toBeNull();
    expect(plan.residual).toEqual(node);
    expect(plan.filtersFullyPhysical).toBe(false);
  });

  it("NOT 包裹 formula：整体回退 residual", () => {
    const node: FilterNode = { kind: "not", child: formulaNode() };
    const plan = compilePlan("t", fields, node, null, null, "u1");
    expect(plan.filterSql).toBeNull();
    expect(plan.residual).toEqual(node);
  });
});
