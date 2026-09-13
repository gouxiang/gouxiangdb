// M1/S6 queryPlan 纯编译器单测（无 DB）：
//  - 18 个 FilterOp 的 physical/residual 分类白名单（含强制回退清单）；
//  - AND 部分下推、OR/NOT 整棵回退、OR 自带括号、互补对 NOT 折叠；
//  - LIKE 通配转义、值全部 ? 绑定（参数顺序与 SQL 占位符同序）；
//  - 排序仅 valueNum 族全物理时下推，否则内存；autoNumber 恒回退。

import { describe, expect, it } from "vitest";
import type { FilterNode, SortSpec } from "@gx/shared-types";
import { compilePlan, physicalAggFuncs, type PlanField } from "../compile.js";

const fields: PlanField[] = [
  { id: "name", type: "singleLineText", isPrimary: true },
  { id: "email", type: "email" },
  { id: "body", type: "longText" },
  { id: "age", type: "number" },
  { id: "stars", type: "rating" },
  { id: "born", type: "date" },
  { id: "ok", type: "checkbox" },
  { id: "status", type: "singleSelect" },
  { id: "tags", type: "multiSelect" },
  { id: "auto", type: "autoNumber" },
  { id: "calc", type: "formula" },
  { id: "link", type: "links" },
];

const cond = (fieldId: string, op: string, value = "x", extra: Record<string, unknown> = {}): FilterNode =>
  ({ kind: "condition", fieldId, op, value, ...extra }) as FilterNode;

function compileOne(node: FilterNode, sorts: SortSpec[] = []) {
  return compilePlan("T1", fields, node, sorts);
}

describe("18 FilterOp 下推白名单分类", () => {
  it("数值族 eq/neq/gt/lt/gte/lte/isEmpty/isNotEmpty 下推 valueNum", () => {
    for (const [op, v] of [["eq", "10"], ["gt", "10"], ["lt", "10"], ["gte", "10"], ["lte", "10"]] as const) {
      const p = compileOne(cond("age", op, v));
      expect(p.filterSql, op).toContain("valueNum");
      expect(p.residual, op).toBeNull();
    }
    const eq = compileOne(cond("age", "eq", "42"));
    expect(eq.filterParams).toEqual(["T1", "age", 42]); // tableId, fieldId, 数值已转 number
    const neq = compileOne(cond("age", "neq", "42"));
    expect(neq.filterSql).toContain("NOT EXISTS"); // 互补折叠
    const empty = compileOne(cond("age", "isEmpty", ""));
    expect(empty.filterSql).toContain(`"isNull"=1`);
    const notEmpty = compileOne(cond("age", "isNotEmpty", ""));
    expect(notEmpty.filterSql).toContain(`"isNull"=0`);
  });

  it("rating 归 valueNum（S4 修复后必须能范围下推）", () => {
    const p = compileOne(cond("stars", "gte", "4"));
    expect(p.filterSql).toContain("valueNum");
    expect(p.filterParams.at(-1)).toBe(4);
    expect(p.residual).toBeNull();
  });

  it("日期 is/isNot 走 valueText 等值，gt/lt/gte/lte 走 valueNum 毫秒", () => {
    const is = compileOne(cond("born", "is", "2026-01-15"));
    expect(is.filterSql).toContain("valueText");
    expect(is.filterParams.at(-1)).toBe("2026-01-15");
    const gt = compileOne(cond("born", "gt", "2026-01-15"));
    expect(gt.filterSql).toContain("valueNum");
    expect(gt.filterParams.at(-1)).toBe(Date.parse("2026-01-15"));
  });

  it("文本 is/isNot/isEmpty/isNotEmpty 下推 valueText（大小写敏感严格相等）", () => {
    expect(compileOne(cond("name", "is", "张三")).filterSql).toContain("valueText");
    expect(compileOne(cond("name", "isNot", "张三")).filterSql).toContain("NOT EXISTS");
    expect(compileOne(cond("name", "isEmpty")).filterSql).toContain(`"isNull"=1`);
    expect(compileOne(cond("name", "isNotEmpty")).filterSql).toContain(`"isNull"=0`);
  });

  it("短文本 isAnyOf/isNoneOf 回退内存（内存大小写不敏感，SQL IN 区分大小写）", () => {
    expect(compileOne(cond("name", "isAnyOf", "a,b,c")).filterSql).toBeNull();
    expect(compileOne(cond("name", "isNoneOf", "a,b")).filterSql).toBeNull();
  });

  it("短文本 contains/startsWith/endsWith 下推参数化 LIKE 并转义通配", () => {
    const c = compileOne(cond("email", "contains", "a%_b\\c"));
    expect(c.filterSql).toContain("LIKE");
    expect(c.filterSql).toContain("ESCAPE");
    expect(c.filterParams.at(-1)).toBe("%a\\%\\_b\\\\c%");
    expect(compileOne(cond("name", "startsWith", "ab")).filterParams.at(-1)).toBe("ab%");
    expect(compileOne(cond("name", "endsWith", "ab")).filterParams.at(-1)).toBe("%ab");
  });

  it("单选 is/isNot/isAnyOf/isNoneOf 下推；多选 isAnyOf/isNoneOf 走多行 IN", () => {
    expect(compileOne(cond("status", "is", "o1")).filterSql).toContain("valueText");
    const tagsAny = compileOne(cond("tags", "isAnyOf", "t1,t2"));
    expect(tagsAny.filterSql).toContain("IN (?,?)");
    expect(tagsAny.filterSql).toContain("EXISTS");
    expect(compileOne(cond("tags", "isNoneOf", "t1")).filterSql).toContain("NOT EXISTS");
  });

  it("checkbox checked/unchecked 各自生成（非互补，unchecked 含空值）", () => {
    const on = compileOne(cond("ok", "checked"));
    expect(on.filterSql).toContain(`x."valueNum"=1`);
    const off = compileOne(cond("ok", "unchecked"));
    expect(off.filterSql).toContain(`"isNull"=1 OR x."valueNum"=0`);
  });
});

describe("强制回退（residual）清单", () => {
  it("notContains 恒回退（EAV 多行 NOT 语义）", () => {
    const p = compileOne(cond("name", "notContains", "x"));
    expect(p.filterSql).toBeNull();
    expect(p.residual).not.toBeNull();
    expect(p.filtersFullyPhysical).toBe(false);
  });

  it("valueType=field 跨列比较恒回退", () => {
    const p = compileOne(cond("age", "eq", "", { valueType: "field", valueFieldId: "stars" }));
    expect(p.filterSql).toBeNull();
    expect(p.residual).not.toBeNull();
  });

  it("formula/links 上任何条件回退", () => {
    expect(compileOne(cond("calc", "gt", "1")).filterSql).toBeNull();
    expect(compileOne(cond("link", "contains", "x")).filterSql).toBeNull();
  });

  it("longText contains 回退（仅短文本四类型 LIKE）", () => {
    expect(compileOne(cond("body", "contains", "x")).filterSql).toBeNull();
    // 主字段若为 shortText 才可 LIKE；body 不是主字段
  });

  it("autoNumber 任何算符/排序回退（sidecar 文本 vs 计算编号语义不一）", () => {
    expect(compileOne(cond("auto", "eq", "1")).filterSql).toBeNull();
    expect(compileOne(cond("auto", "isEmpty")).filterSql).toBeNull();
  });

  it("数值字面量转不成数（gt/非空回退到文本比较）→ 回退", () => {
    const p = compileOne(cond("age", "gt", "abc"));
    expect(p.filterSql).toBeNull();
    expect(p.residual).not.toBeNull();
  });

  it("多选 contains/notContains 回退（子串语义，IN 无法表达）", () => {
    expect(compileOne(cond("tags", "contains", "t1")).filterSql).toBeNull();
    expect(compileOne(cond("tags", "notContains", "t1")).filterSql).toBeNull();
  });
});

describe("AND/OR/NOT 布尔组合", () => {
  it("AND 部分下推：物理叶进 SQL、残余叶留内存", () => {
    const tree: FilterNode = {
      kind: "and",
      children: [cond("age", "gt", "1"), cond("calc", "gt", "2")],
    };
    const p = compileOne(tree);
    expect(p.filterSql).toContain("valueNum"); // 仅 age
    expect(p.filterSql).not.toContain("calc");
    expect(p.residual).toEqual(cond("calc", "gt", "2"));
    expect(p.filtersFullyPhysical).toBe(false);
  });

  it("OR 混入任一不可下推叶 → 整棵回退内存，filterSql=null", () => {
    const tree: FilterNode = {
      kind: "or",
      children: [cond("age", "gt", "1"), cond("calc", "gt", "2")],
    };
    const p = compileOne(tree);
    expect(p.filterSql).toBeNull();
    expect(p.residual).toEqual(tree);
  });

  it("全物理 OR 下推且自带括号", () => {
    const tree: FilterNode = {
      kind: "or",
      children: [cond("age", "gt", "1"), cond("stars", "lt", "5")],
    };
    const p = compileOne(tree);
    expect(p.filterSql).toMatch(/^\(.* OR .*\)$/); // 外层自带括号
    expect(p.filterSql).toContain("valueNum");
    expect(p.residual).toBeNull();
  });

  it("NOT 全物理折叠为 NOT(...)；裹残余则整棵回退", () => {
    const ok = compileOne({ kind: "not", child: cond("age", "gt", "1") } as FilterNode);
    expect(ok.filterSql).toContain("(NOT (");
    const bad = compileOne({ kind: "not", child: cond("calc", "gt", "1") } as FilterNode);
    expect(bad.filterSql).toBeNull();
  });

  it("参数与占位符严格同序（AND 两条件）", () => {
    const tree: FilterNode = {
      kind: "and",
      children: [cond("age", "gt", "10"), cond("stars", "lte", "4")],
    };
    const p = compileOne(tree);
    // 每叶 EXISTS 绑定 tableId, fieldId, value
    expect(p.filterParams).toEqual(["T1", "age", 10, "T1", "stars", 4]);
    const qCount = (p.filterSql!.match(/\?/g) ?? []).length;
    expect(qCount).toBe(p.filterParams.length);
  });
});

describe("同字段范围谓词合并为单 EXISTS", () => {
  it("同字段 gte+lte 合并成一个 EXISTS（一次 tableId/fieldId 绑定，双谓词同 inner）", () => {
    const tree: FilterNode = {
      kind: "and",
      children: [cond("age", "gte", "10"), cond("age", "lte", "20")],
    };
    const p = compileOne(tree);
    expect(p.residual).toBeNull();
    // 只有一个 EXISTS（不是两个相关子查询）。
    expect((p.filterSql!.match(/EXISTS\(/g) ?? []).length).toBe(1);
    expect(p.filterSql).toContain('"valueNum" >= ?');
    expect(p.filterSql).toContain('"valueNum" <= ?');
    expect(p.filterSql).toContain(" AND ");
    // 绑定：tableId → fieldId → 下界 → 上界（与 inner 中 ? 同序）。
    expect(p.filterParams).toEqual(["T1", "age", 10, 20]);
    expect((p.filterSql!.match(/\?/g) ?? []).length).toBe(p.filterParams.length);
  });

  it("同字段三个正向谓词（gt+lt+eq）全部并入单 EXISTS，按 children 原序", () => {
    const tree: FilterNode = {
      kind: "and",
      children: [cond("age", "gt", "1"), cond("age", "lt", "9"), cond("age", "eq", "5")],
    };
    const p = compileOne(tree);
    expect((p.filterSql!.match(/EXISTS\(/g) ?? []).length).toBe(1);
    expect(p.filterParams).toEqual(["T1", "age", 1, 9, 5]);
  });

  it("日期字段同字段范围同样合并为单 EXISTS（valueNum 毫秒）", () => {
    const tree: FilterNode = {
      kind: "and",
      children: [cond("born", "gte", "2026-01-01"), cond("born", "lt", "2026-02-01")],
    };
    const p = compileOne(tree);
    expect((p.filterSql!.match(/EXISTS\(/g) ?? []).length).toBe(1);
    expect(p.filterParams).toEqual(["T1", "born", Date.parse("2026-01-01"), Date.parse("2026-02-01")]);
  });

  it("neq（NOT 折叠）不参与合并，仍独立成 NOT EXISTS", () => {
    const tree: FilterNode = {
      kind: "and",
      children: [cond("age", "gte", "10"), cond("age", "neq", "15")],
    };
    const p = compileOne(tree);
    // 一个正向范围 EXISTS + 一个 NOT EXISTS。
    expect((p.filterSql!.match(/EXISTS\(/g) ?? []).length).toBe(2);
    expect(p.filterSql).toContain("NOT EXISTS");
  });

  it("不同字段的范围谓词不合并（各一个 EXISTS）", () => {
    const tree: FilterNode = {
      kind: "and",
      children: [cond("age", "gte", "10"), cond("stars", "lte", "4")],
    };
    const p = compileOne(tree);
    expect((p.filterSql!.match(/EXISTS\(/g) ?? []).length).toBe(2);
    expect(p.filterParams).toEqual(["T1", "age", 10, "T1", "stars", 4]);
  });

  it("多选字段 isAnyOf 不参与范围合并（多行，∃P1∧∃P2≠∃(P1∧P2)）", () => {
    // tags 两次 isAnyOf 应各自一个 EXISTS，不被当 valueNum 合并。
    const tree: FilterNode = {
      kind: "and",
      children: [cond("tags", "isAnyOf", "a,b"), cond("tags", "isAnyOf", "c")],
    };
    const p = compileOne(tree);
    expect((p.filterSql!.match(/EXISTS\(/g) ?? []).length).toBe(2);
  });
});

describe("排序下推分类", () => {
  it("全物理过滤 + valueNum 族排序 → sortJoins", () => {
    const p = compileOne(cond("age", "gt", "0"), [{ fieldId: "stars", direction: "desc" }]);
    expect(p.sortJoins).toEqual([{ fieldId: "stars", alias: "s0", direction: "desc" }]);
  });

  it("有残余过滤时排序整体回退内存", () => {
    const tree: FilterNode = { kind: "and", children: [cond("age", "gt", "1"), cond("calc", "gt", "2")] };
    const p = compileOne(tree, [{ fieldId: "age", direction: "asc" }]);
    expect(p.sortJoins).toBeNull();
  });

  it("文本/autoNumber/多选/计算字段排序回退（SQLite BINARY != zh-CN numeric）", () => {
    expect(compileOne(cond("age", "gt", "0"), [{ fieldId: "name", direction: "asc" }]).sortJoins).toBeNull();
    expect(compileOne(cond("age", "gt", "0"), [{ fieldId: "auto", direction: "asc" }]).sortJoins).toBeNull();
    expect(compileOne(cond("age", "gt", "0"), [{ fieldId: "tags", direction: "asc" }]).sortJoins).toBeNull();
    expect(compileOne(cond("age", "gt", "0"), [{ fieldId: "calc", direction: "asc" }]).sortJoins).toBeNull();
  });

  it("多排序中夹计算字段 → 整体回退", () => {
    const sorts: SortSpec[] = [
      { fieldId: "age", direction: "asc" },
      { fieldId: "calc", direction: "asc" },
    ];
    expect(compilePlan("T1", fields, null, sorts).sortJoins).toBeNull();
  });

  it("checkbox 排序可下推 valueNum", () => {
    expect(compilePlan("T1", fields, null, [{ fieldId: "ok", direction: "asc" }]).sortJoins).not.toBeNull();
  });
});

describe("physicalAggFuncs 聚合下推资格（防日期 min/max 静默偏差）", () => {
  const ALL = ["count", "countEmpty", "countFilled", "percentEmpty", "percentFilled", "sum", "avg", "min", "max"];
  it("数值五型：全部 9 个可下推", () => {
    for (const t of ["number", "currency", "percent", "duration", "rating"]) {
      expect(physicalAggFuncs(t, ALL).sort(), t).toEqual([...ALL].sort());
    }
  });
  it("checkbox：计数类 + sum/avg/min/max（valueNum 0/1）均可", () => {
    expect(physicalAggFuncs("checkbox", ALL).sort()).toEqual([...ALL].sort());
  });
  it("日期：min/max 必须排除（内存对 ISO 串返回 null，valueNum 是毫秒）", () => {
    const got = physicalAggFuncs("date", ALL);
    expect(got).not.toContain("min");
    expect(got).not.toContain("max");
    expect(got).toEqual(["count", "countEmpty", "countFilled", "percentEmpty", "percentFilled"]);
    expect(physicalAggFuncs("datetime", ["min", "max"])).toEqual([]);
  });
  it("singleSelect 仅计数类；multiSelect/longText/autoNumber/计算字段整体回退", () => {
    expect(physicalAggFuncs("singleSelect", ALL)).toEqual(
      ["count", "countEmpty", "countFilled", "percentEmpty", "percentFilled"],
    );
    for (const t of ["multiSelect", "longText", "autoNumber", "formula", "lookup", "rollup", "count", "links"]) {
      expect(physicalAggFuncs(t, ALL), t).toEqual([]);
    }
  });
});
