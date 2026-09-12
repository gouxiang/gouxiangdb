// apps/api/src/domain/__tests__/cross-formula.test.ts
// 跨表数据新模型：hydration 字段层把点引用 {关联.子字段} 解析为 标量/list/null 注入，
// 公式引擎只做常规函数 + 表达式计算，不再有 LINK_* 专用函数。
// 本文件覆盖：list 聚合（SUM/AVERAGE/MIN/MAX/CONCAT/LEN/FIRST/LAST）、
// 空值传播、嵌套、混合运算、以及 LINK_* 下线后的报错指引。
import { describe, it, expect } from "vitest";
import { safeEvaluateFormula, fnum, fstr, fbool, flist, FNULL, type FormulaValue } from "../formula.js";

/** 模拟 hydration 注入后的字段取值器：点引用已经是带类型的标量/list/null */
function makeSrc(vars: Record<string, FormulaValue>): (name: string) => FormulaValue {
  return (name: string) => vars[name] ?? FNULL;
}

function eval_(formula: string, vars: Record<string, FormulaValue> = {}): FormulaValue {
  const r = safeEvaluateFormula(formula, makeSrc(vars));
  if (r.error) throw new Error(r.error);
  return r.value;
}

describe("点引用 list 聚合（替代 LINK_VALUES 模型）", () => {
  // 三条子记录的金额/状态（hydrate 对多条值注入 flist）
  const vars = {
    "订单明细.金额": flist([fnum(100), fnum(200), fnum(50)]),
    "订单明细.状态": flist([fstr("已付款"), fstr("待付款"), fstr("已付款")]),
    "订单明细.数量": flist([fnum(2), fnum(3), fnum(1)]),
    "空关联.金额": FNULL,
  };

  it("SUM 对多条子记录数值求和 350（核心回归：旧实现拼成字符串导致 NaN）", () => {
    expect(eval_("SUM({订单明细.金额})", vars)).toEqual({ t: "num", v: 350 });
  });

  it("单条子记录注入标量时 SUM 同样正确", () => {
    expect(eval_("SUM({明细.金额})", { "明细.金额": fnum(10) })).toEqual({ t: "num", v: 10 });
  });

  it("两条子记录即正确求和（旧 bug：>=2 条异常）", () => {
    expect(eval_("SUM({明细.金额})", { "明细.金额": flist([fnum(10), fnum(20)]) })).toEqual({ t: "num", v: 30 });
  });

  it("AVERAGE 跨表平均 350/3", () => {
    expect(eval_("AVERAGE({订单明细.金额})", vars)).toEqual({ t: "num", v: 350 / 3 });
  });

  it("MIN/MAX 跨表极值", () => {
    expect(eval_("MIN({订单明细.金额})", vars)).toEqual({ t: "num", v: 50 });
    expect(eval_("MAX({订单明细.金额})", vars)).toEqual({ t: "num", v: 200 });
  });

  it("FIRST / LAST 取首/尾条", () => {
    expect(eval_("FIRST({订单明细.金额})", vars)).toEqual({ t: "num", v: 100 });
    expect(eval_("LAST({订单明细.金额})", vars)).toEqual({ t: "num", v: 50 });
    expect(eval_("FIRST({订单明细.状态})", vars)).toEqual({ t: "str", v: "已付款" });
  });

  it("CONCAT 无分隔拼接 list", () => {
    expect(eval_("CONCAT({订单明细.状态})", vars)).toEqual({ t: "str", v: "已付款待付款已付款" });
  });

  it("LEN 对 list 返回元素个数", () => {
    expect(eval_("LEN({订单明细.金额})", vars)).toEqual({ t: "num", v: 3 });
  });

  it("空关联：SUM=0、FIRST/LAST=null、CONCAT=空串、LEN=0", () => {
    expect(eval_("SUM({空关联.金额})", vars)).toEqual({ t: "num", v: 0 });
    expect(eval_("FIRST({空关联.金额})", vars)).toEqual({ t: "null" });
    expect(eval_("LAST({空关联.金额})", vars)).toEqual({ t: "null" });
    expect(eval_("CONCAT({空关联.金额})", vars)).toEqual({ t: "str", v: "" });
    expect(eval_("LEN({空关联.金额})", vars)).toEqual({ t: "num", v: 0 });
    expect(eval_("AVERAGE({空关联.金额})", vars)).toEqual({ t: "num", v: 0 });
  });

  it("混合运算：子表求和 × 本单折扣 + 固定运费", () => {
    const v = { "订单明细.金额": flist([fnum(100), fnum(200)]), 折扣: fnum(0.8), 运费: fnum(10) };
    expect(eval_("SUM({订单明细.金额}) * {折扣} + {运费}", v)).toEqual({ t: "num", v: 250 });
  });

  it("嵌套函数：ROUND(SUM(...), 0) / IF + LEN / CONCAT 嵌套", () => {
    expect(eval_("ROUND(AVERAGE({订单明细.金额}), 1)", vars)).toEqual({
      t: "num",
      v: Math.round((350 / 3) * 10) / 10,
    });
    expect(eval_('IF(LEN({订单明细.金额}) >= 3, "批量单", "普通单")', vars)).toEqual({ t: "str", v: "批量单" });
    expect(eval_('CONCAT("共", LEN({订单明细.金额}), "条，合计", SUM({订单明细.金额}))', vars)).toEqual({
      t: "str",
      v: "共3条，合计350",
    });
  });

  it("list 与标量同传：SUM 展平混合参数", () => {
    expect(eval_("SUM({订单明细.金额}, {订单明细.数量}, 7)", vars)).toEqual({ t: "num", v: 350 + 6 + 7 });
  });
});

describe("边界处理", () => {
  it("非数字元素混入：SUM 忽略文本/布尔(布尔按 1/0 由 asNum 决定)、只加数值", () => {
    // asNum: bool true→1；文本 "abc"→NaN 被过滤；空串→null 被过滤
    const vars = { xs: flist([fnum(1), fstr("abc"), fnum(2), FNULL, fstr("")]) };
    expect(eval_("SUM({xs})", vars)).toEqual({ t: "num", v: 3 });
  });

  it("纯文本 list 求和 = 0，不静默产生 NaN", () => {
    expect(eval_("SUM({xs})", { xs: flist([fstr("a"), fstr("b")]) })).toEqual({ t: "num", v: 0 });
  });

  it("算术运算遇空值：+ 法数值场景空→0 处理一致；- * / 空值返回 null", () => {
    expect(eval_("{a} - {b}", { a: fnum(5) })).toEqual({ t: "null" });
    expect(eval_("{a} * {b}", { a: fnum(5) })).toEqual({ t: "null" });
    expect(eval_("{a} / {b}", { a: fnum(5) })).toEqual({ t: "null" });
    expect(eval_("{a} / {b}", { a: fnum(5), b: fnum(0) })).toEqual({ t: "null" }); // 除零
  });

  it("文本拼接遇 null 当空串，不出现 'null' 字样", () => {
    expect(eval_('"A" & {x} & "B"', { x: FNULL })).toEqual({ t: "str", v: "AB" });
  });

  it("比较与 IF 对空值行为确定", () => {
    expect(eval_("ISNULL({x})", { x: FNULL })).toEqual({ t: "bool", v: true });
    expect(eval_("ISNULL({x})", { x: fnum(0) })).toEqual({ t: "bool", v: false });
    expect(eval_('IF({x} > 0, "正", "非正")', { x: FNULL })).toEqual({ t: "str", v: "非正" });
  });

  it("布尔字段参与逻辑运算", () => {
    const vars = { 已审: fbool(true), 金额: fnum(100) };
    expect(eval_("{已审} && {金额} >= 100", vars)).toEqual({ t: "bool", v: true });
  });
});

describe("LINK_* 已下线", () => {
  const src = makeSrc({ 订单明细: flist([fnum(1)]) });

  it("调用 LINK_VALUES 报迁移指引错误（safe 模式不炸，error 有消息）", () => {
    const r = safeEvaluateFormula('SUM(LINK_VALUES({订单明细}, "金额"))', src);
    expect(r.value).toEqual(FNULL);
    expect(r.error).toContain("LINK_VALUES 已下线");
    expect(r.error).toContain("订单明细.金额");
  });

  it("LINK_FIRST/LINK_LAST/LINK_COUNT 同样下线", () => {
    expect(safeEvaluateFormula('LINK_FIRST({订单明细}, "金额")', src).error).toContain("已下线");
    expect(safeEvaluateFormula('LINK_LAST({订单明细}, "金额")', src).error).toContain("已下线");
    expect(safeEvaluateFormula("LINK_COUNT({订单明细})", src).error).toContain("已下线");
  });
});
