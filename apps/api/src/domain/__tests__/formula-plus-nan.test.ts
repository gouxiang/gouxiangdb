// apps/api/src/domain/__tests__/formula-plus-nan.test.ts
// 缺陷 1 回归（P2）：加号 `+` 遇到「非数字文本」产出 NaN，落到存储/接口序列化后变成 null。
//
// 现象：网格里 `{订单号} + "-"` 显示空白（同样意图用 `&` 正常显示 "O1-"）；纯字面量 "a" + "b" 也空白；
//       判空探针 ISNULL("a" + "b") 返回 false —— 引擎并不认为结果是 null，而是产出 {t:"num",v:NaN}。
// 根因：apps/api/src/domain/formula.ts case "+" 分支只判 `a !== null && b !== null`，
//       而 asNum() 对非空非数字文本返回 Number("O1") = NaN，NaN !== null 成立 → 直接 fnum(NaN)，
//       其后的 fstr(asString(lv) + asString(rv)) 文本拼接兜底永远走不到；
//       {t:"num",v:NaN} 经 formulaValueToCell 落为 NaN，JSON 序列化后即为 null（单元格空白）。
// 修法：数值加法返回前加 Number.isFinite 守卫，NaN 落回文本拼接兜底。
//
// 本文件同时锁定「不能把正常数值加法改坏」：位置在各 group 的第二段。

import { describe, it, expect } from "vitest";
import { safeEvaluateFormula, FNULL, fnum, fstr, fbool, flist, type FormulaValue } from "../formula.js";

const vars: Record<string, FormulaValue> = {
  订单号: fstr("O1"),
  数量: fnum(3),
  单价: fnum(12.5),
  折扣: fnum(0.7),
  文本数字: fstr("42"),
  已完成: fbool(true),
  空文本: fstr(""),
  备注: FNULL,
  明细: flist([fstr("甲")]),
};

function ev(src: string, v = vars): FormulaValue {
  const r = safeEvaluateFormula(src, (name) => v[name] ?? FNULL);
  expect(r.error).toBeNull();
  return r.value;
}

/**
 * 模拟「引擎结果 → 存储/接口」的真实落值路径：
 * hydrate.ts:745 formulaValueToCell(value) → records.fields JSON → 接口 JSON.stringify。
 * 缺陷现象正是这一步：{t:"num",v:NaN} 会被 JSON.stringify 写成 null（单元格空白）。
 */
function toCell(v: FormulaValue): unknown {
  switch (v.t) {
    case "num":
    case "str":
    case "bool":
      return v.v;
    case "list":
      return v.v.map(toCell); // 与 hydrate.ts:753 一致（列表递归转标量数组）
    case "null":
      return null;
  }
}

function stored(src: string, v = vars): unknown {
  return JSON.parse(JSON.stringify(toCell(ev(src, v))));
}

describe("缺陷 1 · `+` 遇非数字文本不再产出 NaN", () => {
  it("原缺陷用例：{订单号} + \"-\" 得到拼接结果，而不是落库的 null", () => {
    const v = ev('{订单号} + "-"');
    // 修前：{ t: "num", v: NaN }（NaN 不是 null，所以文本兜底走不到）
    expect(v.t).toBe("str");
    expect(v).toEqual({ t: "str", v: "O1-" });
    // 存储/接口层不再被 JSON 序列化成 null
    expect(stored('{订单号} + "-"')).toBe("O1-");
  });

  it("与 & 行为一致（同一意图两种写法结果相同）", () => {
    expect(stored('{订单号} + "-"')).toBe(stored('{订单号} & "-"'));
  });

  it("纯字面量：\"a\" + \"b\" 得到 \"ab\"（修前为 null）", () => {
    expect(ev("'a' + 'b'")).toEqual({ t: "str", v: "ab" });
    expect(stored("'a' + 'b'")).toBe("ab");
  });

  it("旁证：{订单号} + \"\" 仍得到 \"O1\"（asNum(\"\")=null 本就走兜底，行为不变）", () => {
    expect(stored('{订单号} + ""')).toBe("O1");
  });

  it("任一侧为空值/空文本时仍走文本拼接，不产出 NaN", () => {
    expect(stored('{备注} + "-"')).toBe("-");
    expect(stored('{空文本} + "-"')).toBe("-");
    expect(stored('{已完成} + "-"')).toBe("true-");
  });
});

describe("缺陷 1 · 守卫不得破坏正常数值加法", () => {
  it("字面量数值相加", () => {
    expect(ev("1 + 2")).toEqual({ t: "num", v: 3 });
    expect(stored("1 + 2")).toBe(3);
  });

  it("数值字段相加", () => {
    expect(ev("{数量} + {单价}")).toEqual({ t: "num", v: 15.5 });
    expect(ev("{数量} + {折扣}")).toEqual({ t: "num", v: 3.7 });
  });

  it("文本型数字仍按数值相加（Number 可转且有限 → 不该误判为拼接）", () => {
    expect(ev("{文本数字} + 8")).toEqual({ t: "num", v: 50 });
    expect(ev("'3' + '4'")).toEqual({ t: "num", v: 7 });
    expect(ev("{数量} + {文本数字}")).toEqual({ t: "num", v: 45 });
  });

  it("布尔按 1/0 参与数值加法", () => {
    expect(ev("{已完成} + {数量}")).toEqual({ t: "num", v: 4 });
  });

  it("混合场景：数值 + 非数字文本 → 拼接（既不是 NaN，也不是数值）", () => {
    // asNum("-") = Number("-") = NaN → 守卫命中 → 走文本兜底，与 `&` 结果一致
    expect(ev('{数量} + "-"')).toEqual({ t: "str", v: "3-" });
    expect(stored('{数量} + "-"')).toBe(stored('{数量} & "-"'));
  });

  it("列表参与 `+` 仍是列表拼接（既有语义不变）", () => {
    // list 分支在数值分支之前命中，守卫不影响它
    expect(stored("{明细} + \"-\"")).toEqual(["甲", "-"]);
    expect(stored("\"-\" + {明细}")).toEqual(["-", "甲"]);
  });
});
