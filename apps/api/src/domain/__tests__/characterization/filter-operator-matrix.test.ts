// M1/S0 Characterization：过滤操作符真值表
//
// 目的：把 shared evalFilter（packages/shared-types/src/filter.ts）对【全部 FilterOp 成员】
// 在 标量文本 / 数字 / 日期 / 布尔 / 多选数组 / 匹配字段(valueType=field) 上的现状返回值钉死，
// 供 M1 S6「物理字段过滤下推 SQL」后逐格对拍。
//
// Characterization 纪律：只记录现状，不修正任何「看起来怪」的行为；
// 每一个反直觉格子都用注释标出原因，S6 必须复刻同样结果（或显式登记偏差）。
//
// 注：FilterOp 联合类型共 18 个成员（is/isNot/contains/notContains/startsWith/endsWith/
// isEmpty/isNotEmpty/eq/neq/gt/lt/gte/lte/checked/unchecked/isAnyOf/isNoneOf）。
// M1 plan 称「22 个操作符」，对应的是【操作符×字段形态】矩阵的覆盖面；
// 本测试对 18 个成员逐一给值，无遗漏、不臆造不存在的操作符。

import { describe, it, expect } from "vitest";
import { evalFilter, type RawValue } from "@gx/shared-types";
import type { FilterCondition, FilterNode, FilterOp } from "@gx/shared-types";

/** 构造一个 condition 节点 */
function cond(op: FilterOp, extra: Partial<FilterCondition> = {}): FilterNode {
  return {
    kind: "condition",
    fieldId: "F",
    op,
    value: "",
    ...extra,
  };
}

/** 字面量模式：对单元格 cell 应用 op（比较值 lit） */
function run(op: FilterOp, cell: RawValue, lit = ""): boolean {
  return evalFilter(cond(op, { value: lit }), () => cell);
}

/** 匹配字段模式：目标值 cell，本表参照字段 S 的值 selfCell */
function runField(op: FilterOp, cell: RawValue, selfCell: RawValue, lit = ""): boolean {
  return evalFilter(
    cond(op, { value: lit, valueType: "field", valueFieldId: "S" }),
    () => cell,
    () => selfCell,
  );
}

describe("文本标量（singleLineText 存字符串）", () => {
  it("is / isNot 走文本严格相等（区分大小写）", () => {
    expect(run("is", "Alice", "Alice")).toBe(true);
    expect(run("is", "alice", "Alice")).toBe(false);
    expect(run("isNot", "Alice", "Alice")).toBe(false);
    expect(run("isNot", "Bob", "Alice")).toBe(true);
  });

  it("contains/notContains/startsWith/endsWith 大小写不敏感子串", () => {
    expect(run("contains", "Hello World", "world")).toBe(true);
    expect(run("notContains", "Hello World", "xyz")).toBe(true);
    expect(run("startsWith", "Hello World", "hello")).toBe(true);
    expect(run("endsWith", "Hello World", "world")).toBe(true);
  });

  it("【现状怪癖】空字面量子串操作恒真（'' 是任意串的子串）", () => {
    expect(run("contains", "anything", "")).toBe(true);
    expect(run("startsWith", "anything", "")).toBe(true);
    expect(run("endsWith", "anything", "")).toBe(true);
    // notContains 空串：!''.includes('') = false
    expect(run("notContains", "anything", "")).toBe(false);
  });

  it("isEmpty / isNotEmpty 口径", () => {
    expect(run("isEmpty", "")).toBe(true);
    expect(run("isEmpty", null)).toBe(true);
    expect(run("isEmpty", undefined)).toBe(true);
    expect(run("isEmpty", "x")).toBe(false);
    expect(run("isNotEmpty", "x")).toBe(true);
    expect(run("isNotEmpty", "")).toBe(false);
    // 【现状】空对象 {}/空数组 视为空；数字 0、布尔 false 不算空
    expect(run("isEmpty", {})).toBe(true);
    expect(run("isEmpty", 0)).toBe(false);
    expect(run("isEmpty", false)).toBe(false);
  });
});

describe("数字（number 存 number，字面量是字符串）", () => {
  it("eq/neq 两侧经 toNumber 归一：数字 10 与字符串 '10' 相等", () => {
    expect(run("eq", 10, "10")).toBe(true);
    expect(run("eq", "10", "10")).toBe(true);
    expect(run("neq", 11, "10")).toBe(true);
  });

  it("【现状怪癖】布尔在数值比较里当 1/0：true eq '1' 为真", () => {
    expect(run("eq", true, "1")).toBe(true);
    expect(run("eq", false, "0")).toBe(true);
  });

  it("【现状怪癖】任一侧无法转数字时 eq/neq 回退为文本严格比较", () => {
    // toNumber('10a')=null → '10a' === '10' false
    expect(run("eq", "10a", "10")).toBe(false);
    // null 单元格：'' === '10' false（eq），'' !== '10' true（neq）
    expect(run("eq", null, "10")).toBe(false);
    expect(run("neq", null, "10")).toBe(true);
    expect(run("neq", null, "")).toBe(false);
  });

  it("gt/lt/gte/lte 数值比较，无法转数字或空值一律 false", () => {
    expect(run("gt", 15, "10")).toBe(true);
    expect(run("lt", 5, "10")).toBe(true);
    expect(run("gte", 10, "10")).toBe(true);
    expect(run("lte", 10, "10")).toBe(true);
    expect(run("gt", "abc", "10")).toBe(false);
    expect(run("gt", null, "10")).toBe(false);
    expect(run("lt", null, "10")).toBe(false);
  });

  it("数字带千分位逗号的字面量也能比较（toComparableText 不去逗号，但 toNumber 直接 Number）", () => {
    // 单元格是 number 1234 → toNumber=1234；字面量 '1,234' → Number('1,234')=NaN → false
    expect(run("eq", 1234, "1,234")).toBe(false);
    expect(run("gt", 1234, "1000")).toBe(true);
  });
});

describe("日期（date 存 'YYYY-MM-DD'，datetime 存 ISO）", () => {
  it("gt/lt 对日期形态走 Date.parse 时间戳比较（非 NaN 数值比较）", () => {
    expect(run("gt", "2026-09-13", "2026-01-01")).toBe(true);
    expect(run("lt", "2026-03-01", "2026-09-13")).toBe(true);
    expect(run("gte", "2026-09-13T08:00", "2026-09-13T00:00")).toBe(true);
    expect(run("lte", "2026-09-13", "2026-09-13")).toBe(true);
  });

  it("【现状】日期 eq 也走时间戳：同一天日期字符串相等", () => {
    expect(run("eq", "2026-09-13", "2026-09-13")).toBe(true);
  });

  it("非日期文本不被当时间戳", () => {
    expect(run("gt", "not-a-date", "2026-01-01")).toBe(false);
  });

  it("日期 is 仍走文本严格相等（不做时间戳归一）", () => {
    expect(run("is", "2026-09-13", "2026-09-13")).toBe(true);
    expect(run("is", "2026-09-13T00:00", "2026-09-13")).toBe(false);
  });
});

describe("布尔（checkbox 存 boolean）", () => {
  it("checked 接受 true/1/文本 '1'/'true'", () => {
    expect(run("checked", true)).toBe(true);
    expect(run("checked", 1)).toBe(true);
    expect(run("checked", "1")).toBe(true);
    expect(run("checked", "true")).toBe(true);
    expect(run("checked", false)).toBe(false);
    expect(run("checked", null)).toBe(false);
  });

  it("unchecked 接受 false/0/空值/'0'/'false'", () => {
    expect(run("unchecked", false)).toBe(true);
    expect(run("unchecked", 0)).toBe(true);
    expect(run("unchecked", null)).toBe(true);
    expect(run("unchecked", "")).toBe(true);
    expect(run("unchecked", "0")).toBe(true);
    expect(run("unchecked", "false")).toBe(true);
    expect(run("unchecked", true)).toBe(false);
    // 【现状】任意非 0/1/false 文本：既不 checked 也不 unchecked
    expect(run("unchecked", "maybe")).toBe(false);
  });
});

describe("多选（multiSelect 存 optionId 字符串数组）", () => {
  it("contains/notContains 对【每个元素】做大小写不敏感子串，不做整串 join", () => {
    expect(run("contains", ["opt_a", "opt_b"], "opt_b")).toBe(true);
    expect(run("contains", ["apple", "banana"], "ban")).toBe(true);
    // 跨元素子串不命中：没有任何单一元素包含 "apple, ba"
    expect(run("contains", ["apple", "banana"], "apple, ba")).toBe(false);
    expect(run("notContains", ["opt_a"], "opt_b")).toBe(true);
  });

  it("isAnyOf：任一元素与列表任一项【精确】(大小写不敏感)相等", () => {
    expect(run("isAnyOf", ["opt_a", "opt_b"], "opt_a, opt_c")).toBe(true);
    expect(run("isAnyOf", ["opt_a"], "OPT_A")).toBe(true);
    expect(run("isAnyOf", ["opt_x"], "opt_a, opt_b")).toBe(false);
  });

  it("isNoneOf：没有任何元素命中列表", () => {
    expect(run("isNoneOf", ["opt_x"], "opt_a, opt_b")).toBe(true);
    expect(run("isNoneOf", ["opt_a"], "opt_a")).toBe(false);
  });

  it("【现状怪癖】非数组单元格走标量分支：isAnyOf 用 items.includes(整串文本)", () => {
    expect(run("isAnyOf", "opt_a", "opt_a, opt_b")).toBe(true);
    expect(run("isAnyOf", "solo", "so,lo")).toBe(false); // 整串 "solo" 不等于任一 item
  });

  it("【现状怪癖】空列表字面量：isAnyOf=false，isNoneOf=true", () => {
    expect(run("isAnyOf", ["opt_a"], "")).toBe(false);
    expect(run("isNoneOf", ["opt_a"], "")).toBe(true);
  });

  it("空数组视为空值", () => {
    expect(run("isEmpty", [])).toBe(true);
    expect(run("isNotEmpty", ["x"])).toBe(true);
  });
});

describe("单选（singleSelect 存 optionId 纯字符串）", () => {
  it("is/contains 走文本；isAnyOf 精确匹配列表", () => {
    expect(run("is", "opt_a", "opt_a")).toBe(true);
    expect(run("isAnyOf", "opt_b", "opt_a, opt_b")).toBe(true);
    expect(run("isNoneOf", "opt_c", "opt_a, opt_b")).toBe(true);
  });
});

describe("匹配字段 valueType=field（比较值来自本表另一字段）", () => {
  it("eq/gt 用参照字段的数值比较", () => {
    expect(runField("eq", 10, 10)).toBe(true);
    expect(runField("gt", 15, 10)).toBe(true);
    expect(runField("lt", 5, 10)).toBe(true);
  });

  it("is/contains 用参照字段的文本", () => {
    expect(runField("is", "Alice", "Alice")).toBe(true);
    expect(runField("contains", "Hello World", "world")).toBe(true);
  });

  it("【现状怪癖】field 模式 isAnyOf 把参照字段文本按逗号 split 后比对", () => {
    // 标量目标 "opt_a"，参照字段 "opt_a,opt_b" → items=["opt_a","opt_b"] → 命中
    expect(runField("isAnyOf", "opt_a", "opt_a,opt_b")).toBe(true);
    // 数组目标：arrayContainsAny(v, [整串 fText])，fText 是逗号串，单元素不等于整串 → false
    expect(runField("isAnyOf", ["opt_a", "opt_b"], "opt_a,opt_b")).toBe(false);
    // 数组目标：参照字段恰为单值 "opt_a" → 命中
    expect(runField("isAnyOf", ["opt_a"], "opt_a")).toBe(true);
  });

  it("【现状】无值操作符（isEmpty/checked 等）忽略 valueType，按目标值判定", () => {
    expect(runField("isEmpty", "", "anything")).toBe(true);
    expect(runField("checked", true, false)).toBe(true);
  });
});

describe("脏节点防御（坏 FilterNode 不抛错，按无约束处理）", () => {
  it("未知 kind / 缺 children 的 and/or / 缺 child 的 not 均放行", () => {
    expect(evalFilter({ kind: "and", children: [] } as unknown as FilterNode, () => false)).toBe(true);
    expect(evalFilter({ kind: "or", children: [] } as unknown as FilterNode, () => false)).toBe(true);
    expect(evalFilter({ kind: "not" } as unknown as FilterNode, () => false)).toBe(true);
    expect(evalFilter({ kind: "weird" } as unknown as FilterNode, () => false)).toBe(true);
    expect(evalFilter(null, () => false)).toBe(true);
    expect(evalFilter(undefined, () => false)).toBe(true);
  });

  it("and/or/not 组合真值", () => {
    const a = cond("eq", { value: "1" });
    const b = cond("gt", { value: "0" });
    expect(
      evalFilter({ kind: "and", children: [a, b] }, () => 1),
    ).toBe(true);
    expect(
      evalFilter({ kind: "or", children: [a, cond("eq", { value: "9" })] }, () => 1),
    ).toBe(true);
    expect(
      evalFilter({ kind: "not", child: cond("eq", { value: "9" }) }, () => 1),
    ).toBe(true);
  });
});
