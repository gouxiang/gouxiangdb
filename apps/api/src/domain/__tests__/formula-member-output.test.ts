// apps/api/src/domain/__tests__/formula-member-output.test.ts
// 成员字段的公式默认内容：输出必须是成员（userId），姓名文本一律拦下。
//
// 现象（产品需求 2026-10-02）：成员字段值存的是 userId，前端按 userId 查通讯录名册取姓名。
// 若公式产出姓名文本（IF({状态}="完成", "张三", "李四")），落库的是中文名 → 名册查不到 →
// 界面退化显示成一串 id。这是脏数据，必须在保存字段配置时（validateFormulaOutput）拦下，
// 而不是等渲染时才发现。
//
// 本文件同时锁住任务 B 的回归：inferAST 收的是字段「分组」而非「类型」，
// datetime 字段引用日期字段不得再被误报「类型不匹配」（type=datetime 但 group=date）。

import { describe, it, expect } from "vitest";
import { validateFormulaOutput, infersMember, parseFormula } from "../formula.js";
import { fieldTypeGroup, type FieldType } from "@gx/shared-types";

// 表中字段名 → 字段类型（与 validateFieldConfig 里的 fieldsOfTable 同形）
const fieldTypes: Record<string, string> = {
  负责人: "member",
  审核人: "member",
  状态: "singleSelect",
  姓名: "singleLineText",
  下单时间: "datetime",
  生日: "date",
  数量: "number",
  已交付: "checkbox",
};
const byName = (n: string): string | undefined => fieldTypes[n];
// 调用口径（fieldValidation.ts:80 起）：第三个参数传 group
const groupByName = (n: string): string | undefined => {
  const t = byName(n);
  return t === undefined ? undefined : fieldTypeGroup(t as FieldType);
};

describe("成员字段公式 · 输出必须是成员", () => {
  it("直接引用成员字段 → 通过", () => {
    expect(validateFormulaOutput("{负责人}", "member", groupByName, byName)).toBeNull();
  });

  it("IF 各分支都是成员字段 → 通过", () => {
    const src = 'IF({状态} = "完成", {负责人}, {审核人})';
    expect(validateFormulaOutput(src, "member", groupByName, byName)).toBeNull();
  });

  it("IF 分支里混了姓名文本 → 拒绝，并说明原因与正确写法", () => {
    const err = validateFormulaOutput('IF({状态} = "完成", "张三", {审核人})', "member", groupByName, byName);
    expect(err).not.toBeNull();
    expect(err).toContain("成员");
    expect(err).toContain("{负责人}"); // 给出了可照抄的正确写法示例
    expect(err).not.toContain("类型不匹配"); // 比「类型不匹配」更贴近真实问题
  });

  it("IF 缺 else 分支（求值为空）→ 通过", () => {
    expect(validateFormulaOutput('IF({状态} = "完成", {负责人})', "member", groupByName, byName)).toBeNull();
  });

  it("IF 分支用 BLANK() 留空 → 通过", () => {
    expect(validateFormulaOutput('IF({状态} = "完成", {负责人}, BLANK())', "member", groupByName, byName)).toBeNull();
  });

  it("纯字符串字面量 → 拒绝", () => {
    const err = validateFormulaOutput('"张三"', "member", groupByName, byName);
    expect(err).not.toBeNull();
    expect(err).toContain("成员");
  });

  it("引用文本字段 → 拒绝（文本字段的值是姓名/文本，不是成员 ID）", () => {
    const err = validateFormulaOutput("{姓名}", "member", groupByName, byName);
    expect(err).not.toBeNull();
    expect(err).toContain("成员");
  });

  it("文本函数包成员（CONCAT）→ 拒绝", () => {
    const err = validateFormulaOutput('CONCAT({负责人}, "")', "member", groupByName, byName);
    expect(err).not.toBeNull();
    // CONCAT 返回文本，文本不是成员 ID
    expect(err).toContain("成员");
  });

  it("比较表达式（产出布尔）→ 拒绝", () => {
    expect(validateFormulaOutput('{状态} = "完成"', "member", groupByName, byName)).not.toBeNull();
  });

  it("BLANK() 视为不填 → 通过", () => {
    expect(validateFormulaOutput("BLANK()", "member", groupByName, byName)).toBeNull();
  });
});

describe("成员字段公式 · SWITCH 按 evalCall 真实排布判定", () => {
  // evalCall（formula.ts:530-539）排布：args[0]=待匹配值；(匹配值, 结果值) 成对；
  // 参数总数为偶数时最后一个参数是 default 结果。
  const isMember = (n: string): boolean => byName(n) === "member";

  it("SWITCH 全部结果分支为成员（无 default）→ 通过", () => {
    const src = 'SWITCH({状态}, "完成", {负责人}, "驳回", {审核人})';
    expect(infersMember(parseFormula(src), isMember)).toBe(true);
    expect(validateFormulaOutput(src, "member", groupByName, byName)).toBeNull();
  });

  it("SWITCH 带 default 且 default 也是成员 → 通过", () => {
    // 6 个参数（偶数）→ 最后一个是 default 结果值
    const src = 'SWITCH({状态}, "完成", {负责人}, "驳回", {审核人}, {负责人})';
    expect(infersMember(parseFormula(src), isMember)).toBe(true);
    expect(validateFormulaOutput(src, "member", groupByName, byName)).toBeNull();
  });

  it("SWITCH 的 default 是姓名文本 → 拒绝（default 也是一条真实输出路径）", () => {
    const src = 'SWITCH({状态}, "完成", {负责人}, "驳回", {审核人}, "张三")';
    expect(infersMember(parseFormula(src), isMember)).toBe(false);
    expect(validateFormulaOutput(src, "member", groupByName, byName)).toContain("成员");
  });

  it("SWITCH 中间分支是姓名文本 → 拒绝", () => {
    const src = 'SWITCH({状态}, "完成", "张三", "驳回", {审核人})';
    expect(infersMember(parseFormula(src), isMember)).toBe(false);
  });

  it("SWITCH 的匹配值不是成员不影响判定（匹配值不参与输出）", () => {
    // 匹配值是与 {状态} 比较的文本，只有结果值需要是成员
    const src = 'SWITCH({状态}, "完成", {负责人})';
    expect(infersMember(parseFormula(src), isMember)).toBe(true);
  });
});

describe("任务 B 回归 · inferAST 收 group 而非 type", () => {
  it("datetime 字段：引用 datetime 字段不再被误报类型不匹配", () => {
    // 修前：byName 返回 type "datetime"，inferAST 的 fieldRef 分支只认 group "date" →
    // 落到兜底 str → 与 expect=date 不匹配 → 误报。修后传 group（date）→ 通过。
    expect(validateFormulaOutput("{下单时间}", "datetime", groupByName, byName)).toBeNull();
    expect(validateFormulaOutput("DATEADD({下单时间}, 3)", "datetime", groupByName, byName)).toBeNull();
  });

  it("date 字段：引用 date 字段通过", () => {
    expect(validateFormulaOutput("{生日}", "date", groupByName, byName)).toBeNull();
  });

  it("checkbox 字段：引用勾选字段通过（type=checkbox / group=bool 同类误报一并修掉）", () => {
    expect(validateFormulaOutput("{已交付}", "checkbox", groupByName, byName)).toBeNull();
  });

  it("datetime 字段仍会拒绝真正的类型错误（未放宽）", () => {
    expect(validateFormulaOutput("{数量} + 1", "datetime", groupByName, byName)).toContain("日期");
    expect(validateFormulaOutput('CONCAT({姓名}, "x")', "datetime", groupByName, byName)).toContain("日期");
  });

  it("成员字段的 group 是 container，落到兜底 str，与 expect=str 一致不误报", () => {
    expect(fieldTypeGroup("member" as FieldType)).toBe("container");
    expect(validateFormulaOutput("{负责人}", "member", groupByName, byName)).toBeNull();
  });
});
