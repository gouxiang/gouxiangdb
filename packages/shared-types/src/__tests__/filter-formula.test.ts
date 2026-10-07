// packages/shared-types/src/__tests__/filter-formula.test.ts
// 高级模式筛选（kind:"formula"）的内存求值契约：
// 空表达式 -> true（无筛选）；无回调 -> false（fail-closed）；
// 回调抛错 / 返回非布尔 -> false；严格布尔（truthy 不命中）。

import { describe, it, expect } from "vitest";
import { evalFilter } from "../filter.js";
import type { FilterNode } from "../filters.js";
import { filterReferencesCurrentUser } from "../filters.js";

const formula = (expression: string): FilterNode => ({ kind: "formula", expression });
const noop = () => null;

describe("evalFilter formula 基础契约", () => {
  it("空表达式 -> true（无筛选）", () => {
    expect(evalFilter(formula(""), noop)).toBe(true);
    expect(evalFilter(formula("   "), noop)).toBe(true);
  });

  it("非空表达式但未注入 evalFormula -> false（fail-closed）", () => {
    expect(evalFilter(formula("{x} > 1"), noop)).toBe(false);
    // 不传 ctx 同样 false
    expect(evalFilter(formula("{x} > 1"), noop, undefined, undefined)).toBe(false);
  });

  it("回调返回 true -> 命中；false -> 不命中", () => {
    const ctxT = { evalFormula: () => true };
    const ctxF = { evalFormula: () => false };
    expect(evalFilter(formula("true"), noop, undefined, ctxT)).toBe(true);
    expect(evalFilter(formula("false"), noop, undefined, ctxF)).toBe(false);
  });

  it("回调抛错 -> false（fail-closed，不向上抛）", () => {
    const ctx = { evalFormula: () => { throw new Error("boom"); } };
    expect(evalFilter(formula("bad"), noop, undefined, ctx)).toBe(false);
  });

  it("严格布尔：truthy 值（1 / 非空字符串）不构成命中", () => {
    expect(evalFilter(formula("x"), noop, undefined, { evalFormula: () => 1 as unknown as boolean })).toBe(false);
    expect(evalFilter(formula("x"), noop, undefined, { evalFormula: () => "yes" as unknown as boolean })).toBe(false);
  });

  it("表达式被原样传给回调", () => {
    let got = "";
    evalFilter(formula("{数量} > 3"), noop, undefined, {
      evalFormula: (expression: string) => { got = expression; return true; },
    });
    expect(got).toBe("{数量} > 3");
  });
});

describe("evalFilter formula 在布尔树内", () => {
  it("AND：两公式都为真才命中", () => {
    const node: FilterNode = {
      kind: "and",
      children: [formula("a"), formula("b")],
    };
    const truth: Record<string, boolean> = { a: true, b: true };
    const ctx = { evalFormula: (e: string) => truth[e] === true };
    expect(evalFilter(node, noop, undefined, ctx)).toBe(true);
    truth.b = false;
    expect(evalFilter(node, noop, undefined, ctx)).toBe(false);
  });

  it("NOT(false 公式) = true —— 公式语义由回调决定，非 fail-closed 短路", () => {
    const node: FilterNode = { kind: "not", child: formula("a") };
    const ctx = { evalFormula: () => false };
    expect(evalFilter(node, noop, undefined, ctx)).toBe(true);
  });

  it("OR：任一公式为真即命中", () => {
    const node: FilterNode = { kind: "or", children: [formula("a"), formula("b")] };
    const truth: Record<string, boolean> = { a: false, b: true };
    const ctx = { evalFormula: (e: string) => truth[e] === true };
    expect(evalFilter(node, noop, undefined, ctx)).toBe(true);
  });
});

describe("formula 与 currentUser", () => {
  it("filterReferencesCurrentUser 对 formula 节点返回 false（公式无内置 currentUser）", () => {
    expect(filterReferencesCurrentUser(formula('{创建人} = "x"'))).toBe(false);
  });

  it("AND(condition currentUser, formula) 在无登录态整树 fail-closed，即便公式为真", () => {
    const currentUserCond = {
      kind: "condition", fieldId: "f", op: "is", value: "",
      valueType: "dynamic", dynamicValue: "currentUser",
    } as FilterNode;
    const node: FilterNode = { kind: "and", children: [currentUserCond, formula("a")] };
    const ctx = { vars: { currentUserId: null }, evalFormula: () => true };
    expect(evalFilter(node, noop, undefined, ctx)).toBe(false);
  });
});
