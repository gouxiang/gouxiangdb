// apps/api/src/domain/__tests__/formula-conditional-fns.test.ts
// 条件聚合与新增高频函数单元测试：
// SUMIF / COUNTIF / AVERAGEIF（数字相等、比较符、通配符、下标对齐、无匹配）、
// COUNT / COUNTA（扁平列表、Excel 口径）、YEAR / MONTH / DAY（正常与非法输入），
// 以及含 FNULL 占位列表上 SUM/AVERAGE/FIRST/LAST 的零回归固定。

import { describe, it, expect } from "vitest";
import { safeEvaluateFormula, FNULL, fnum, fstr, fbool, flist, type FormulaValue } from "../formula.js";

function makeSrc(vars: Record<string, FormulaValue>): (name: string) => FormulaValue {
  return (name) => vars[name] ?? FNULL;
}

function eval_(formula: string, vars: Record<string, FormulaValue> = {}): FormulaValue {
  const r = safeEvaluateFormula(formula, makeSrc(vars));
  if (r.error) throw new Error(r.error);
  return r.value;
}

const numOf = (f: string, v: Record<string, FormulaValue> = {}): number => {
  const r = eval_(f, v);
  expect(r.t, `expected num, got ${r.t}`).toBe("num");
  return (r as { v: number }).v;
};

describe("SUMIF —— criteria 三类形态", () => {
  const base = {
    "订单明细.金额": flist([fnum(100), fnum(200), fnum(50)]),
    "订单明细.数量": flist([fnum(2), fnum(3), fnum(1)]),
    "订单明细.状态": flist([fstr("已付款"), fstr("待付款"), fstr("已付款")]),
    "订单明细.商品名": flist([fstr("张三订单"), fstr("李四订单"), fstr("王五退款单")]),
  };

  it("数字 criteria 精确相等（省略求和范围 → 累加 range 自身）", () => {
    expect(numOf("SUMIF({订单明细.金额}, 200)", base)).toBe(200);
    expect(numOf("SUMIF({订单明细.数量}, 1)", base)).toBe(1);
  });

  it("文本 criteria 带比较符（数字列宽松转数后比较）", () => {
    expect(numOf("SUMIF({订单明细.金额}, '>100')", base)).toBe(200);
    expect(numOf("SUMIF({订单明细.金额}, '>=100')", base)).toBe(300);
    expect(numOf("SUMIF({订单明细.金额}, '<>200')", base)).toBe(150);
    expect(numOf("SUMIF({订单明细.金额}, '<=50')", base)).toBe(50);
  });

  it("文本 criteria 带比较符 + 独立求和范围", () => {
    // 金额 > 90 的行：100(数量2)、200(数量3) → 数量之和 5
    expect(numOf("SUMIF({订单明细.金额}, '>90', {订单明细.数量})", base)).toBe(5);
  });

  it("无前缀文本按相等匹配；数字列与文本数字条件按数值相等", () => {
    expect(numOf('SUMIF({订单明细.状态}, "已付款", {订单明细.金额})', base)).toBe(150);
    expect(numOf('SUMIF({订单明细.金额}, "100", {订单明细.数量})', base)).toBe(2);
  });

  it("通配符 * 与 ?（~ 转义），整串匹配", () => {
    // 张* → "张三订单"（金额 100）
    expect(numOf('SUMIF({订单明细.商品名}, "张*", {订单明细.金额})', base)).toBe(100);
    // *订单 → 张三订单、李四订单（100+200），"王五退款单" 不匹配
    expect(numOf('SUMIF({订单明细.商品名}, "*订单", {订单明细.金额})', base)).toBe(300);
    // 张?订单：? 为单字符 → "张三订单"
    expect(numOf('SUMIF({订单明细.商品名}, "张?订单", {订单明细.金额})', base)).toBe(100);
    // ~* 转义：字面量 *，无匹配 → 0
    expect(numOf('SUMIF({订单明细.商品名}, "~*", {订单明细.金额})', base)).toBe(0);
  });
});

describe("SUMIF —— 下标对齐与边界", () => {
  it("中间子记录缺求和值：FNULL 占位，不错位累加", () => {
    const v = {
      s: flist([fstr("已付款"), fstr("待付款"), fstr("已付款")]),
      a: flist([fnum(100), FNULL, fnum(50)]),
    };
    // 下标 0 与 2 命中 → 100 + 50；下标 1 求和值为 null 跳过
    expect(numOf('SUMIF({s}, "已付款", {a})', v)).toBe(150);
  });

  it("中间子记录缺条件值：FNULL 占位，不错位", () => {
    const v = {
      s: flist([fstr("已付款"), FNULL, fstr("已付款")]),
      a: flist([fnum(100), fnum(200), fnum(50)]),
    };
    // 若过滤 null 导致列表错位，会错算成 100+200=300；保位后应为 100+50=150
    expect(numOf('SUMIF({s}, "已付款", {a})', v)).toBe(150);
  });

  it("无任何匹配返回 0；range 为 null 返回 0；标量 range 按单元素", () => {
    expect(numOf('SUMIF({s}, "不存在", {a})', {
      s: flist([fstr("x")]), a: flist([fnum(1)]),
    })).toBe(0);
    expect(numOf('SUMIF({s}, "已付款", {a})', { s: FNULL, a: flist([fnum(1)]) })).toBe(0);
    expect(numOf('SUMIF({s}, "已付款", {a})', { s: fstr("已付款"), a: fnum(42) })).toBe(42);
    expect(numOf("SUMIF({x}, 5)", { x: fnum(5) })).toBe(5);
  });
});

describe("COUNTIF", () => {
  const v = {
    "订单明细.状态": flist([fstr("已付款"), fstr("待付款"), fstr("已付款"), FNULL]),
    "订单明细.金额": flist([fnum(100), fnum(200), fnum(50)]),
  };

  it("统计满足条件的非空元素个数", () => {
    expect(numOf('COUNTIF({订单明细.状态}, "已付款")', v)).toBe(2);
    expect(numOf("COUNTIF({订单明细.金额}, '>=100')", v)).toBe(2);
    expect(numOf("COUNTIF({订单明细.金额}, 200)", v)).toBe(1);
  });

  it("null 元素不计；range 为 null 返回 0", () => {
    expect(numOf('COUNTIF({订单明细.状态}, "已付款")', { ...v, "订单明细.状态": FNULL })).toBe(0);
  });
});

describe("AVERAGEIF", () => {
  const v = {
    s: flist([fstr("已付款"), fstr("待付款"), fstr("已付款")]),
    a: flist([fnum(100), fnum(200), fnum(50)]),
  };

  it("命中行求平均", () => {
    expect(numOf('AVERAGEIF({s}, "已付款", {a})', v)).toBe(75);
  });

  it("省略第三参数对 range 自身数值求平均", () => {
    expect(numOf("AVERAGEIF({a}, '>90')", v)).toBe(150);
  });

  it("无任何匹配返回 0（与 AVERAGE 空集口径一致）", () => {
    expect(numOf('AVERAGEIF({s}, "无此状态", {a})', v)).toBe(0);
    expect(numOf('AVERAGEIF({x}, "x", {y})', { x: FNULL, y: FNULL })).toBe(0);
  });
});

describe("COUNT / COUNTA", () => {
  const v = {
    xs: flist([fnum(1), fstr("abc"), fnum(2), fbool(true), FNULL, fstr("100"), fstr("")]),
    more: fnum(9),
  };

  it("COUNT：仅数值型；布尔/文本/null 不计，数字文本不转数；列表扁平化", () => {
    expect(numOf("COUNT({xs})", v)).toBe(2);
    expect(numOf("COUNT({xs}, {more})", v)).toBe(3);
  });

  it("COUNTA：非空元素个数；空字符串计入，null 不计；列表扁平化", () => {
    // 1, "abc", 2, true, "100", "" 共 6 个
    expect(numOf("COUNTA({xs})", v)).toBe(6);
    expect(numOf("COUNTA({xs}, {more})", v)).toBe(7);
  });
});

describe("YEAR / MONTH / DAY", () => {
  it("ISO 纯日期与日期时间文本", () => {
    expect(numOf("YEAR({d})", { d: fstr("2026-10-06") })).toBe(2026);
    expect(numOf("MONTH({d})", { d: fstr("2026-10-06") })).toBe(10);
    expect(numOf("DAY({d})", { d: fstr("2026-10-06") })).toBe(6);
    expect(numOf("YEAR({d})", { d: fstr("2026-10-06T08:00:00.000Z") })).toBe(2026);
  });

  it("毫秒时间戳数字", () => {
    const ts = Date.UTC(2025, 0, 31);
    expect(numOf("YEAR({t})", { t: fnum(ts) })).toBe(2025);
    expect(numOf("MONTH({t})", { t: fnum(ts) })).toBe(1);
    expect(numOf("DAY({t})", { t: fnum(ts) })).toBe(31);
  });

  it("非法输入返回 null", () => {
    for (const fn of ["YEAR", "MONTH", "DAY"]) {
      expect(eval_(`${fn}({d})`, { d: fstr("not-a-date") })).toBe(FNULL);
      expect(eval_(`${fn}({d})`, { d: fstr("") })).toBe(FNULL);
      expect(eval_(`${fn}({d})`, { d: FNULL })).toBe(FNULL);
    }
  });
});

describe("保位后既有函数零回归（列表含 FNULL 占位）", () => {
  const v = { a: flist([fnum(100), FNULL, fnum(50)]) };

  it("SUM 过滤 null 求和 150", () => {
    expect(numOf("SUM({a})", v)).toBe(150);
  });

  it("AVERAGE 过滤 null 求平均 75", () => {
    expect(numOf("AVERAGE({a})", v)).toBe(75);
  });

  it("FIRST/LAST 取首/尾值", () => {
    expect(eval_("FIRST({a})", v)).toEqual(fnum(100));
    expect(eval_("LAST({a})", v)).toEqual(fnum(50));
  });

  it("MIN/MAX 忽略 null", () => {
    expect(numOf("MIN({a})", v)).toBe(50);
    expect(numOf("MAX({a})", v)).toBe(100);
  });

  it("CONCAT 中 null 当空串拼接", () => {
    const s = flist([fstr("100"), FNULL, fstr("50")]);
    expect(eval_("CONCAT({s})", { s })).toEqual(fstr("10050"));
  });
});
