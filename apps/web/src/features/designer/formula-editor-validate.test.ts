// 公式编辑器实时校验回归（缺陷 F-03）：
// 后端 Tokenizer 对无法识别的字符直接抛「公式错误：意外字符 'x' 位置 n」，但那要等到保存才报，
// 且是技术文案；编辑器此前只查括号配平 / 未知字段 / 未知函数 / 参数个数，对非法运算符一律放行，
// 用户点「确定」看不到任何错误，保存时才被后端 400 顶回来（弹窗不关、无可读提示）。
//
// 本文件锁住两件事：
//   1. 非法字符（如单个 `|`、`^`、`@`）在编辑器里就被拦下，给出中文可读提示；
//   2. 合法写法（`||`、`&&`、`&`、含特殊字符的字符串字面量与字段引用）不得被误判。

import { describe, it, expect } from "vitest";
import type { FieldDTO } from "@gx/shared-types";
import { validateFormula } from "./FormulaEditorModal";

const fields = [
  { id: "f1", name: "订单号", type: "singleLineText" },
  { id: "f2", name: "金额", type: "number" },
] as unknown as FieldDTO[];

const errs = (src: string) => validateFormula(src, fields);

describe("公式编辑器 · 非法运算符拦截（F-03）", () => {
  it("单个竖线 | 被拦下，并提示「或」运算应写 ||", () => {
    const e = errs("{订单号} | 1");
    expect(e.length).toBeGreaterThan(0);
    expect(e.join("\n")).toContain("||");
    expect(e.join("\n")).toContain("|");
  });

  it("其它非法字符（^ @ # $ [ ] 等）同样被拦下", () => {
    for (const ch of ["^", "@", "#", "$", "[", "]", "?", "\\", "~"]) {
      expect(errs(`1 ${ch} 2`).length, `字符 ${ch} 应被判非法`).toBeGreaterThan(0);
    }
  });

  it("报错带位置信息，便于用户定位", () => {
    expect(errs("1 + 2 @ 3").join("\n")).toMatch(/位置/);
  });
});

describe("公式编辑器 · 合法写法不得误判", () => {
  it("||（或）与 &&（且）合法", () => {
    expect(errs('IF({金额} > 1 || {金额} < 0, "是", "否")')).toEqual([]);
    expect(errs('IF({金额} > 1 && {金额} < 9, "是", "否")')).toEqual([]);
  });

  it("& 拼接、四则运算与比较运算合法", () => {
    expect(errs('{订单号} & "-1"')).toEqual([]);
    expect(errs("({金额} + 2) * 3 % 4 / 5 - 1")).toEqual([]);
    expect(errs("{金额} != 0")).toEqual([]);
    expect(errs("{金额} >= 3")).toEqual([]);
  });

  it("字符串字面量与字段引用内部的特殊字符不参与判定", () => {
    expect(errs('CONCAT("a|b^c", {订单号})')).toEqual([]);
    expect(errs("'含 @ 与 # 的文本'")).toEqual([]);
  });

  it("既有校验未被破坏：括号不配对 / 未知字段 / 未知函数仍报错", () => {
    expect(errs("SUM({金额}").length).toBeGreaterThan(0);
    expect(errs("{不存在的字段}")).toContain("未知字段引用：{不存在的字段}");
    expect(errs("NOPE(1)").join("\n")).toContain("未知函数");
  });
});
