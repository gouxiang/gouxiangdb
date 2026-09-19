// apps/api/src/domain/__tests__/formula-fn-metadata-parity.test.ts
// 缺陷 3 回归（P3）：CONCATENATE / OR_F 引擎已实现，但共享包元数据未登记，
// 前端公式编辑器因此判「未知函数」并置灰保存按钮。
//
// 现象：公式编辑器输入 CONCATENATE(...) 报「未知函数：CONCATENATE」且无法保存。
// 根因：packages/shared-types/src/formula-functions.ts 的 FORMULA_FUNCTIONS 无这两条；
//       前端 apps/web/src/features/designer/FormulaEditorModal.tsx:411 `getFormulaFn(c.name)`
//       取不到定义 → :412 推入「未知函数」错误 → :243 errors.length > 0 使确定按钮 disabled。
//       后端其实早已支持：formula.ts:537-539 CONCAT/CONCATENATE 共用实现（别名），
//       formula.ts:607-609 OR/OR_F 共用实现（别名）；FN_RETURN（:764/:768）也登记了两者。
// 修法：在 FORMULA_FUNCTIONS 补 CONCATENATE（等价 CONCAT）与 OR_F（等价 OR）。后端零改动。
//
// 本文件是「元数据 ↔ 引擎实现」的对拍：既断言元数据存在，也断言它与后端求值/返回类型一致，
// 避免补出来的元数据与实现不符（前端能存、后端算出别的语义）。

import { describe, it, expect } from "vitest";
import { FORMULA_FUNCTIONS, getFormulaFn, formulaFnsByCategory } from "@gx/shared-types";
import { evaluateFormula, validateFormulaOutput, FNULL, type FormulaValue } from "../formula.js";

function ev(src: string, vars: Record<string, FormulaValue> = {}): FormulaValue {
  return evaluateFormula(src, (name) => vars[name] ?? FNULL);
}

describe("缺陷 3 · 元数据存在性与大小写不敏感查表", () => {
  it("FORMULA_FUNCTIONS 已登记 CONCATENATE 与 OR_F（修前零命中）", () => {
    const names = FORMULA_FUNCTIONS.map((f) => f.name);
    expect(names).toContain("CONCATENATE");
    expect(names).toContain("OR_F");
  });

  it("getFormulaFn 能命中（前端 :411 的判据），且大小写不敏感", () => {
    // 前端就是用 getFormulaFn 判「未知函数」，这条红就是缺陷本身
    for (const n of ["CONCATENATE", "concatenate", "Concatenate", "OR_F", "or_f", "Or_F"]) {
      expect(getFormulaFn(n), `getFormulaFn(${n}) 应命中`).toBeDefined();
    }
  });

  it("两条元数据归到了正确的分类页签", () => {
    expect(getFormulaFn("CONCATENATE")!.category).toBe("common");
    expect(getFormulaFn("OR_F")!.category).toBe("logic");
    expect(formulaFnsByCategory("common").map((f) => f.name)).toContain("CONCATENATE");
    expect(formulaFnsByCategory("logic").map((f) => f.name)).toContain("OR_F");
  });
});

describe("缺陷 3 · CONCATENATE 元数据与后端 CONCAT 别名实现一致", () => {
  const cat = getFormulaFn("CONCAT")!;
  const alias = getFormulaFn("CONCATENATE")!;

  it("签名/返回/arity 与 CONCAT 同构（后端共用同一 case）", () => {
    expect(alias.returns).toBe(cat.returns);
    expect(alias.returns).toBe("文本");
    expect(alias.arity).toEqual(cat.arity);
    expect(alias.arity).toEqual({ min: 1, max: null }); // 可变参数
    expect(alias.params).toHaveLength(cat.params.length);
    expect(alias.params[0]!.type).toBe(cat.params[0]!.type);
  });

  it("引擎求值：CONCATENATE 与 CONCAT 结果逐案一致（别名而非新实现）", () => {
    const cases = [
      "CONCAT('a', 'b')",
      "CONCAT('订单-', 'O1')",
      "CONCAT('数量=', 3)",
      "CONCAT('a', '', 'b')",
      "CONCAT()",
      "CONCAT('单引号', \"双引号\")",
    ];
    for (const c of cases) {
      expect(ev(c.replace("CONCAT(", "CONCATENATE("))).toEqual(ev(c));
    }
  });

  it("返回类型：后端产出文本（宿主文本字段放行、数值字段拒绝）", () => {
    expect(ev("CONCATENATE('a', 'b')")).toEqual({ t: "str", v: "ab" });
    const noField = () => undefined;
    expect(validateFormulaOutput("CONCATENATE({省}, {市})", "singleLineText", noField)).toBeNull();
    expect(validateFormulaOutput("CONCATENATE({省}, {市})", "number", noField)).toContain("类型不匹配");
  });
});

describe("缺陷 3 · OR_F 元数据与后端 OR 别名实现一致", () => {
  const or = getFormulaFn("OR")!;
  const alias = getFormulaFn("OR_F")!;

  it("签名/返回/arity 与 OR 同构（后端共用同一 case）", () => {
    expect(alias.returns).toBe(or.returns);
    expect(alias.returns).toBe("布尔");
    expect(alias.arity).toEqual(or.arity);
    expect(alias.arity).toEqual({ min: 1, max: null });
    expect(alias.params).toHaveLength(or.params.length);
    expect(alias.params[0]!.type).toBe(or.params[0]!.type);
  });

  it("引擎求值：OR_F 与 OR 结果逐案一致（布尔/braces 短路语义相同）", () => {
    const cases = [
      "OR(true, false)",
      "OR(false, false)",
      "OR(1, 0)",
      "OR('x', '')",
      "OR(true)",
      "OR(false, true, false)",
    ];
    for (const c of cases) {
      expect(ev(c.replace("OR(", "OR_F("))).toEqual(ev(c));
    }
  });

  it("返回类型：后端产出布尔（宿主勾选字段放行、文本字段拒绝）", () => {
    expect(ev("OR_F(false, true)")).toEqual({ t: "bool", v: true });
    expect(ev("OR_F(0, '')")).toEqual({ t: "bool", v: false });
    const noField = () => undefined;
    expect(validateFormulaOutput('OR_F({类型} = "VIP", {金额} > 1000)', "checkbox", noField)).toBeNull();
    expect(validateFormulaOutput('OR_F({类型} = "VIP", {金额} > 1000)', "singleLineText", noField)).toContain("类型不匹配");
  });
});

describe("缺陷 3 · 前端 arity 校验逐参数的真值核对", () => {
  it("两条例句的参数个数落在各自 arity 区间内（否则前端存不进去）", () => {
    for (const name of ["CONCATENATE", "OR_F"]) {
      const def = getFormulaFn(name)!;
      // 例句里顶层参数个数：按逗号切分（例句无嵌套逗号）
      const argc = def.example.slice(def.example.indexOf("(") + 1, def.example.lastIndexOf(")")).split(",").length;
      expect(argc).toBeGreaterThanOrEqual(def.arity.min);
      if (def.arity.max !== null) expect(argc).toBeLessThanOrEqual(def.arity.max);
    }
  });

  it("signature 与 name 自洽（前端列表按 signature 展示）", () => {
    for (const name of ["CONCATENATE", "OR_F"]) {
      const def = getFormulaFn(name)!;
      expect(def.signature.startsWith(`${def.name}(`)).toBe(true);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.example.includes(`${def.name}(`)).toBe(true);
    }
  });
});
