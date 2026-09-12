// apps/api/src/domain/__tests__/formula.test.ts
// 公式引擎单元测试（v1 Core/FormulaEngine.swift 行为对齐）
//
// 这份测试是「v1 → v2 行为一致」的核心证据：
// v1 的 Swift 实现与 v2 的 TS 实现必须对同一公式串给出同一结果。

import { describe, it, expect } from "vitest";
import {
  evaluateFormula,
  safeEvaluateFormula,
  formulaFieldRefs,
  parseFormula,
  FormulaError,
  type FormulaValue,
} from "../formula.js";

function vals(obj: Record<string, string | number | boolean | null>): (n: string) => FormulaValue {
  return (n: string) => {
    const v = obj[n];
    if (v === undefined || v === null) return { t: "null" };
    if (typeof v === "number") return { t: "num", v };
    if (typeof v === "boolean") return { t: "bool", v };
    return { t: "str", v };
  };
}

const num = (s: string, v: Record<string, string | number | boolean | null>): number | null => {
  const r = evaluateFormula(s, vals(v));
  return r.t === "num" ? r.v : null;
};
const str = (s: string, v: Record<string, string | number | boolean | null>): string => {
  const r = evaluateFormula(s, vals(v));
  return r.t === "str" ? r.v : r.t === "num" ? String(r.v) : r.t === "bool" ? String(r.v) : "";
};
const bool = (s: string, v: Record<string, string | number | boolean | null>): boolean => {
  const r = evaluateFormula(s, vals(v));
  return r.t === "bool" ? r.v : false;
};

describe("Tokenizer —— 特殊字符处理（v1 同构）", () => {
  it("单个 = 变成 ==", () => {
    expect(bool("{a} = 1", { a: 1 })).toBe(true);
    expect(bool("{a} = 2", { a: 1 })).toBe(false);
  });

  it("&& 是 AND，单个 & 是拼接", () => {
    expect(str("'a' & 'b'", {})).toBe("ab");
    expect(bool("true && false", {})).toBe(false);
    expect(bool("true && true", {})).toBe(true);
  });

  it("|| 是 OR，单个 | 报错", () => {
    expect(bool("true || false", {})).toBe(true);
    expect(() => parseFormula("true | false")).toThrow(FormulaError);
  });

  it("! 与 != 区分", () => {
    expect(bool("!false", {})).toBe(true);
    expect(bool("1 != 2", {})).toBe(true);
  });

  it("<= 与 >= 正确分词", () => {
    expect(bool("1 <= 1", {})).toBe(true);
    expect(bool("2 >= 3", {})).toBe(false);
  });

  it("中文标识符与中文字段名可用", () => {
    expect(num("{数量} * 2", { 数量: 21 })).toBe(42);
  });

  it("字符串支持单引号与双引号与转义", () => {
    expect(str("'abc'", {})).toBe("abc");
    expect(str('"abc"', {})).toBe("abc");
    expect(str("'a\\'b'", {})).toBe("a'b");
  });
});

describe("Pratt 解析 —— 优先级（v1 bindingPower 同构）", () => {
  it("乘除优先于加减", () => {
    expect(num("2 + 3 * 4", {})).toBe(14);
    expect(num("(2 + 3) * 4", {})).toBe(20);
  });

  it("比较优先于 AND/OR", () => {
    expect(bool("1 < 2 && 3 > 2", {})).toBe(true);
    expect(bool("1 > 2 || 3 > 2", {})).toBe(true);
  });

  it("一元负号优先级高于乘法", () => {
    expect(num("-2 * 3", {})).toBe(-6);
    expect(num("-(2 + 3)", {})).toBe(-5);
  });

  it("取模正确", () => {
    expect(num("7 % 3", {})).toBe(1);
  });

  it("除零返回 null 而不是 Infinity / 崩溃", () => {
    expect(num("1 / 0", {})).toBe(null);
  });

  it("末尾多余 token 报错", () => {
    expect(() => parseFormula("1 2")).toThrow(FormulaError);
  });
});

describe("相等语义（v1 valueEqual 同构：两边都是文本时严格比较）", () => {
  it("数值型 1.0 == 1", () => {
    expect(bool("1.0 == 1", {})).toBe(true);
  });

  it("文本型 '10' ≠ '10.0'（不做数值转换）", () => {
    expect(bool("'10' == '10.0'", {})).toBe(false);
  });

  it("文本与数字混合时按数值比较", () => {
    expect(bool("'10' == 10", {})).toBe(true);
  });

  it("!= 与 == 严格互为否定", () => {
    for (const expr of ["1 == 1", "'a' == 'a'", "'10' == '10.0'", "{a} == 1"]) {
      const v = { a: 1 };
      const eq = bool(expr, v);
      const ne = bool(expr.replace("==", "!="), v);
      expect(ne).toBe(!eq);
    }
  });
});

describe("文本函数", () => {
  it("CONCAT / CONCATENATE 拼接", () => {
    expect(str("CONCAT('a', 'b', 'c')", {})).toBe("abc");
    expect(str("CONCATENATE('a', 'b')", {})).toBe("ab");
  });

  it("TRIM / UPPER / LOWER", () => {
    expect(str("TRIM('  a b  ')", {})).toBe("a b");
    expect(str("UPPER('abc')", {})).toBe("ABC");
    expect(str("LOWER('ABC')", {})).toBe("abc");
  });

  it("LEN 按字符数（中文算 1 个）", () => {
    expect(num("LEN('abc')", {})).toBe(3);
    expect(num("LEN('中文')", {})).toBe(2);
  });

  it("LEFT / RIGHT 负数长度做下界保护为 0", () => {
    expect(str("LEFT('abcdef', 3)", {})).toBe("abc");
    expect(str("RIGHT('abcdef', 2)", {})).toBe("ef");
    expect(str("LEFT('abcdef', -1)", {})).toBe("");
    expect(str("RIGHT('abcdef', 0)", {})).toBe("");
  });

  it("REPLACE 全部替换", () => {
    expect(str("REPLACE('a-b-c', '-', '+')", {})).toBe("a+b+c");
  });

  it("SEARCH 是 1-based，未找到返回 0", () => {
    expect(num("SEARCH('abcdef', 'abc')", {})).toBe(1);
    expect(num("SEARCH('abcdef', 'cd')", {})).toBe(3);
    expect(num("SEARCH('abcdef', 'zz')", {})).toBe(0);
  });

  it("SUBSTR / REPT", () => {
    expect(str("SUBSTR('abcdef', 2, 3)", {})).toBe("bcd");
    expect(str("REPT('ab', 3)", {})).toBe("ababab");
    expect(str("REPT('ab', 0)", {})).toBe("");
  });
});

describe("数学函数", () => {
  it("ROUND 四舍五入（远离零）", () => {
    expect(num("ROUND(3.14159, 2)", {})).toBe(3.14);
    expect(num("ROUND(2.5, 0)", {})).toBe(3);
    expect(num("ROUND(-2.5, 0)", {})).toBe(-3);
  });

  it("CEILING / FLOOR / ABS / INT / SQRT / POWER / MOD", () => {
    expect(num("CEILING(2.1)", {})).toBe(3);
    expect(num("FLOOR(2.9)", {})).toBe(2);
    expect(num("ABS(-3)", {})).toBe(3);
    expect(num("INT(3.9)", {})).toBe(3);
    expect(num("SQRT(16)", {})).toBe(4);
    expect(num("POWER(2, 10)", {})).toBe(1024);
    expect(num("MOD(7, 3)", {})).toBe(1);
  });

  it("MIN / MAX / SUM / AVERAGE", () => {
    expect(num("MIN(3, 1, 2)", {})).toBe(1);
    expect(num("MAX(3, 1, 2)", {})).toBe(3);
    expect(num("SUM(1, 2, 3)", {})).toBe(6);
    expect(num("AVERAGE(1, 2, 3)", {})).toBe(2);
  });
});

describe("逻辑函数", () => {
  it("IF 三参与两参", () => {
    expect(str("IF(true, 'yes', 'no')", {})).toBe("yes");
    expect(str("IF(false, 'yes', 'no')", {})).toBe("no");
    const two = safeEvaluateFormula("IF(false, 'yes')", vals({}));
    expect(two.value.t).toBe("null");
  });

  it("SWITCH 命中 / 默认值 / 无默认", () => {
    expect(str("SWITCH('b', 'a', 1, 'b', 2, 'c', 3)", {})).toBe("2");
    expect(str("SWITCH('z', 'a', 1, 'b', 2, 99)", {})).toBe("99");
    const none = safeEvaluateFormula("SWITCH('z', 'a', 1, 'b', 2)", vals({}));
    expect(none.value.t).toBe("null");
  });

  it("AND / OR / NOT / ISNULL / BLANK", () => {
    expect(bool("AND(true, true)", {})).toBe(true);
    expect(bool("AND(true, false)", {})).toBe(false);
    expect(bool("OR(false, true)", {})).toBe(true);
    expect(bool("NOT(true)", {})).toBe(false);
    expect(bool("ISNULL(BLANK())", {})).toBe(true);
    expect(bool("ISNULL(1)", {})).toBe(false);
  });
});

describe("日期函数", () => {
  it("TODAY 返回 YYYY-MM-DD", () => {
    const s = str("TODAY()", {});
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("NOW 返回 ISO 串", () => {
    const s = str("NOW()", {});
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("DATETIME_DIFF 默认按天", () => {
    expect(num("DATETIME_DIFF('2024-01-11', '2024-01-01')", {})).toBe(10);
    expect(num("DATETIME_DIFF('2024-01-11', '2024-01-01', 'days')", {})).toBe(10);
    expect(num("DATETIME_DIFF('2024-01-11', '2024-01-01', 'weeks')", {})).toBeCloseTo(10 / 7, 5);
  });

  it("DATEADD 按天加", () => {
    const r = str("DATEADD('2024-01-01', 5)", {});
    expect(r.startsWith("2024-01-06")).toBe(true);
  });
});

describe("字段引用与错误处理", () => {
  it("未定义字段视为 null", () => {
    expect(num("{不存在} + 1", {})).toBe(null);
  });

  it("空值参与算术得到 null", () => {
    expect(num("{a} - 1", { a: null })).toBe(null);
  });

  it("未知函数抛出 FormulaError", () => {
    expect(() => evaluateFormula("FOO(1)", vals({}))).toThrow(FormulaError);
  });

  it("safeEvaluateFormula 出错返回 null 且带 message", () => {
    const r = safeEvaluateFormula("FOO(1)", vals({}));
    expect(r.value.t).toBe("null");
    expect(r.error).toContain("未知函数");
  });

  it("formulaFieldRefs 提取顶层字段名（含点引用）", () => {
    const refs = formulaFieldRefs("{数量} * {单价} + {客户.等级}");
    expect(refs).toContain("数量");
    expect(refs).toContain("单价");
    expect(refs).toContain("客户.等级");
  });

  it("公式错误时 formulaFieldRefs 返回空数组而不是抛错", () => {
    expect(formulaFieldRefs("{a + 1")).toEqual([]);
  });
});

describe("等号写法兼容（v2 对 v1 的有意增强）", () => {
  it("v1 写法：单个 = 表示相等", () => {
    expect(bool("1 = 1", {})).toBe(true);
    expect(bool("1 = 2", {})).toBe(false);
    expect(bool("{a} = 1", { a: 1 })).toBe(true);
  });

  it("v2 新增：== 同样可用（v1 会解析失败）", () => {
    expect(bool("1 == 1", {})).toBe(true);
    expect(bool("1 == 2", {})).toBe(false);
  });

  it("= 与 == 结果一致", () => {
    for (const [a, b] of [["1", "1"], ["1", "2"], ["'a'", "'a'"], ["'a'", "'b'"]]) {
      expect(bool(`${a} = ${b}`, {})).toBe(bool(`${a} == ${b}`, {}));
    }
  });
});
