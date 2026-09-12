// apps/api/src/domain/__tests__/formula-output-type.test.ts
// 公式输出类型校验：文本字段公式须产出文本、数值字段须产出数值、日期字段须产出日期，类型不符报错。

import { describe, it, expect } from "vitest";
import { validateFormulaOutput } from "../formula.js";

// 表中字段名 → 字段类型
const fieldTypes: Record<string, string> = {
  数量: "number",
  单价: "number",
  金额: "currency",
  姓名: "singleLineText",
  生日: "date",
  下单时间: "datetime",
  已付款: "checkbox",
  城市: "singleSelect",
};
const byName = (n: string): string | undefined => fieldTypes[n];

describe("validateFormulaOutput", () => {
  it("数值字段：算术公式通过", () => {
    expect(validateFormulaOutput("{数量} * {单价}", "number", byName)).toBeNull();
    expect(validateFormulaOutput("SUM({数量}, 1)", "currency", byName)).toBeNull();
    expect(validateFormulaOutput("ROUND({金额}, 2)", "percent", byName)).toBeNull();
  });

  it("数值字段：文本/布尔公式不通过", () => {
    const err = validateFormulaOutput('CONCAT({姓名}, "!")', "number", byName);
    expect(err).toContain("数值");
    const err2 = validateFormulaOutput("{数量} > 10", "number", byName);
    expect(err2).toContain("数值");
  });

  it("文本字段：拼接/文本函数通过，数值算术不通过", () => {
    expect(validateFormulaOutput('CONCAT({姓名}, "-", {城市})', "singleLineText", byName)).toBeNull();
    expect(validateFormulaOutput("UPPER({姓名})", "longText", byName)).toBeNull();
    const err = validateFormulaOutput("{数量} * {单价}", "singleLineText", byName);
    expect(err).toContain("文本");
  });

  it("加号精确推断：纯数值字面量相加不得放行到文本字段（回归 1+2 误判）", () => {
    // 1+2 两侧均为数值 → 结果必为数值，文本字段应拒绝
    const err = validateFormulaOutput("1 + 2", "singleLineText", byName);
    expect(err).toContain("文本");
    // 数值字段接受 1+2
    expect(validateFormulaOutput("1 + 2", "number", byName)).toBeNull();
    // 含文本操作数的 + 为字符串拼接，文本字段接受
    expect(validateFormulaOutput('{姓名} + "!"', "singleLineText", byName)).toBeNull();
    // 数值字段 + 文本拼接 → 产文本，数值字段应拒绝
    const err2 = validateFormulaOutput('{数量} + {姓名}', "number", byName);
    expect(err2).toContain("数值");
  });

  it("日期字段：引用日期字段/日期函数通过，数值/文本不通过", () => {
    expect(validateFormulaOutput("{生日}", "date", byName)).toBeNull();
    expect(validateFormulaOutput("TODAY()", "date", byName)).toBeNull();
    expect(validateFormulaOutput("DATEADD({下单时间}, 3)", "datetime", byName)).toBeNull();
    const err = validateFormulaOutput("{数量} + 1", "date", byName);
    expect(err).toContain("日期");
    const err2 = validateFormulaOutput('CONCAT({姓名}, "x")', "datetime", byName);
    expect(err2).toContain("日期");
  });

  it("布尔字段：比较表达式通过", () => {
    expect(validateFormulaOutput("{数量} > 10", "checkbox", byName)).toBeNull();
    expect(validateFormulaOutput("AND({已付款}, {数量} > 0)", "checkbox", byName)).toBeNull();
    const err = validateFormulaOutput('CONCAT({姓名}, "x")', "checkbox", byName);
    expect(err).toContain("布尔");
  });

  it("IF 分支类型并集：文本分支+空分支可用于文本字段", () => {
    expect(validateFormulaOutput('IF({数量} > 10, "大", "小")', "singleLineText", byName)).toBeNull();
  });

  it("语法错误公式报错", () => {
    const err = validateFormulaOutput("{数量} * ", "number", byName);
    expect(typeof err).toBe("string");
    expect((err ?? "").length).toBeGreaterThan(0);
  });

  it("空公式报错", () => {
    expect(validateFormulaOutput("   ", "number", byName)).toContain("不能为空");
  });
});
