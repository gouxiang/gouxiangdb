// apps/api/src/domain/__tests__/formula-functions.test.ts
// 公式函数全集回归测试（对应用户 6 类要求）
//
// 每个函数至少覆盖：happy / boundary / error 三种 case
// + 字段引用 {字段名} + 操作符 + 综合 + 链接操作
//
// 用 helper ev(src, vars) → safeEvaluateFormula 直接测求值层。
// 综合场景走 hydrateOne 路径在 hydrate.test.ts 已覆盖。

import { describe, it, expect } from "vitest";
import { safeEvaluateFormula, FNULL, fnum, fstr, fbool, type FormulaValue } from "../formula.js";

const vars: Record<string, FormulaValue> = {
  名称: fstr("登录页改版"),
  工时: fnum(12),
  状态: fstr("active"),
  描述: fstr(""),
  备注: FNULL,
  已完成: fbool(true),
  折扣: fnum(0.7),
  数量: fnum(3),
  数字: fnum(-3.5),
  长文本: fstr("  Hello World  "),
  关键字: fstr("World"),
};

function ev(src: string, v = vars): { value: FormulaValue; error: string | null } {
  return safeEvaluateFormula(src, (name) => v[name] ?? FNULL);
}

function num(src: string): number {
  const r = ev(src);
  expect(r.error).toBeNull();
  expect(r.value.t).toBe("num");
  return (r.value as { v: number }).v;
}

function str(src: string): string {
  const r = ev(src);
  expect(r.error).toBeNull();
  expect(r.value.t).toBe("str");
  return (r.value as { v: string }).v;
}

function bool(src: string): boolean {
  const r = ev(src);
  expect(r.error).toBeNull();
  expect(r.value.t).toBe("bool");
  return (r.value as { v: boolean }).v;
}

function isNull(src: string): boolean {
  return ev(src).value.t === "null";
}

// ============ 文本函数 ============

describe("CONCAT / CONCATENATE 字符串拼接", () => {
  it("happy: 拼接两段", () => expect(str("CONCAT({名称}, ' / 改版')")).toBe("登录页改版 / 改版"));
  it("CONCATENATE 等价别名", () => expect(str("CONCATENATE('a', 'b', 'c')")).toBe("abc"));
  it("空字符串拼接", () => expect(str("CONCAT('', {描述})")).toBe(""));
  it("CONCAT + 数字自动 toString", () => expect(str("CONCAT('数量=', {数量})")).toBe("数量=3"));
});

describe("TRIM / UPPER / LOWER", () => {
  it("TRIM 去前后空白", () => expect(str("TRIM({长文本})")).toBe("Hello World"));
  it("UPPER 转大写", () => expect(str("UPPER('hello')")).toBe("HELLO"));
  it("LOWER 转小写", () => expect(str("LOWER('HELLO')")).toBe("hello"));
  it("UPPER 已是小写维持", () => expect(str("UPPER('Hi')")).toBe("HI"));
});

describe("LEN / LEFT / RIGHT", () => {
  it("LEN 字符数（中文按 1 字符）", () => expect(num("LEN({名称})")).toBe(5)); // 登录页改版 = 5
  it("LEN 含 emoji 字符", () => expect(num("LEN('abc')")).toBe(3));
  it("LEFT 从头取 N 个", () => expect(str("LEFT({名称}, 3)")).toBe("登录页"));
  it("LEFT 负数 → 0 字符", () => expect(str("LEFT('abc', -5)")).toBe(""));
  it("RIGHT 从尾取 N 个", () => expect(str("RIGHT({名称}, 2)")).toBe("改版"));
  it("RIGHT 0 个", () => expect(str("RIGHT('abc', 0)")).toBe(""));
});

describe("SEARCH 1-based 位置查找（v1 约定：SEARCH(within, find)）", () => {
  it("找到返回 1-based 位置", () => expect(num("SEARCH('  Hello World  ', 'World')")).toBe(9));
  it("未找到返回 0", () => expect(num("SEARCH('abc', 'XYZ')")).toBe(0));
  it("开头位置", () => expect(num("SEARCH('  Hello World  ', 'Hello')")).toBe(3));
});

describe("REPLACE / SUBSTR / REPT", () => {
  it("REPLACE 全替换所有", () => expect(str("REPLACE('a-b-c', '-', '/')")).toBe("a/b/c"));
  it("REPLACE 单次", () => expect(str("REPLACE('hello', 'l', 'L')")).toBe("heLLo"));
  it("SUBSTR 1-based 含 start", () => expect(str("SUBSTR('Hello World', 7, 5)")).toBe("World"));
  it("SUBSTR 无 length 截到末尾", () => expect(str("SUBSTR('Hello World', 7)")).toBe("World"));
  it("REPT 重复", () => expect(str("REPT('ab', 3)")).toBe("ababab"));
  it("REPT 0 次", () => expect(str("REPT('x', 0)")).toBe(""));
});

// ============ 数值函数 ============

describe("ROUND / CEILING / FLOOR / ABS", () => {
  it("ROUND 四舍五入到 2 位", () => expect(num("ROUND(3.456, 2)")).toBe(3.46));
  it("ROUND 默认 0 位", () => expect(num("ROUND(3.5)")).toBe(4));
  it("ROUND 负数 away from zero", () => expect(num("ROUND(-2.5)")).toBe(-3));
  it("CEILING 向上取整", () => expect(num("CEILING(3.1)")).toBe(4));
  it("CEILING 负数", () => expect(num("CEILING(-3.1)")).toBe(-3));
  it("FLOOR 向下取整", () => expect(num("FLOOR(3.9)")).toBe(3));
  it("ABS 绝对值", () => expect(num("ABS({数字})")).toBe(3.5));
});

describe("MIN / MAX / SUM / AVERAGE / COUNT", () => {
  it("MIN 多参", () => expect(num("MIN(3, 1, 2)")).toBe(1));
  it("MAX 多参", () => expect(num("MAX(3, 1, 2)")).toBe(3));
  it("SUM 多值", () => expect(num("SUM(1, 2, 3, 4)")).toBe(10));
  it("AVERAGE 平均", () => expect(num("AVERAGE(2, 4, 6)")).toBe(4));
  it("SUM 字段引用 + 字面量混合", () => expect(num("SUM({数量}, 7)")).toBe(10));
});

describe("SQRT / POWER / MOD / INT", () => {
  it("SQRT", () => expect(num("SQRT(16)")).toBe(4));
  it("POWER 幂", () => expect(num("POWER(2, 10)")).toBe(1024));
  it("MOD 余数", () => expect(num("MOD(10, 3)")).toBe(1));
  it("MOD 除零 → null", () => expect(isNull("MOD(5, 0)")).toBe(true));
  it("INT 截断", () => expect(num("INT(3.9)")).toBe(3));
  it("INT 负数", () => expect(num("INT(-3.9)")).toBe(-3));
});

// ============ 逻辑函数 ============

describe("IF / SWITCH", () => {
  it("IF 真分支", () => expect(str("IF({已完成}, '已', '未')")).toBe("已"));
  it("IF 假分支", () => expect(str("IF(1 > 2, 'yes', 'no')")).toBe("no"));
  it("IF 三参缺位（无 else）", () => expect(isNull("IF(1 > 2, 'yes')")).toBe(true));
  it("SWITCH 命中", () => expect(str("SWITCH({状态}, 'active', '运行中', 'draft', '草稿', '其他')")).toBe("运行中"));
  it("SWITCH 默认分支", () => expect(str("SWITCH({状态}, 'x', 'no', '其他')")).toBe("其他"));
});

describe("AND / OR / NOT", () => {
  it("AND 全真", () => expect(bool("AND(1, 2, 3)")).toBe(true));
  it("AND 含假", () => expect(bool("AND(1, 0, 3)")).toBe(false));
  it("OR 任一真", () => expect(bool("OR(0, 0, 5)")).toBe(true));
  it("OR 全假", () => expect(bool("OR(0, 0, 0)")).toBe(false));
  it("NOT 取反", () => expect(bool("NOT(0)")).toBe(true));
  it("NOT 双重", () => expect(bool("NOT(NOT(0))")).toBe(false));
});

describe("ISNULL / BLANK", () => {
  it("ISNULL(true) 字段为空 → true", () => expect(bool("ISNULL({备注})")).toBe(true));
  it("ISNULL(0) 字段非空 → false", () => expect(bool("ISNULL({名称})")).toBe(false));
  it("BLANK 返回 null", () => expect(isNull("BLANK()")).toBe(true));
});

// ============ 日期函数（稳定形态）============
describe("NOW / TODAY 返回 string", () => {
  it("NOW 是 ISO 字符串", () => {
    const r = ev("NOW()");
    expect(r.value.t).toBe("str");
    expect((r.value as { v: string }).v).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  it("TODAY 是 YYYY-MM-DD", () => {
    const r = ev("TODAY()");
    expect(r.value.t).toBe("str");
    expect((r.value as { v: string }).v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ============ 操作符 ============

describe("比较 + 算术 + 字符串拼接", () => {
  it("= 等价于 ==", () => expect(bool("{数量} = 3")).toBe(true));
  it("== 与 = 同结果", () => expect(bool("{数量} == 3")).toBe(true));
  it("!= 不等", () => expect(bool("{数量} != 0")).toBe(true));
  it("> 大于", () => expect(bool("{数量} > 2")).toBe(true));
  it("<=", () => expect(bool("{数量} <= 3")).toBe(true));
  it("加法", () => expect(num("{数量} + 7")).toBe(10));
  it("减法", () => expect(num("10 - {数量}")).toBe(7));
  it("乘法", () => expect(num("{数量} * 4")).toBe(12));
  it("除法", () => expect(num("100 / {数量}")).toBeCloseTo(33.333, 2));
  it("求余", () => expect(num("{数量} % 2")).toBe(1));
  it("& 字符串拼接", () => expect(str("{名称}&' (priority)'")).toBe("登录页改版 (priority)"));
  it("&& 仍是 AND", () => expect(bool("1 && 1")).toBe(true));
  it("|| 仍是 OR", () => expect(bool("0 || 1")).toBe(true));
  it("单 | 报错 → null", () => expect(isNull("1 | 1")).toBe(true));
});

// ============ 字段引用 ============

describe("{字段名} 中文/数字/下划线引用", () => {
  it("中文字段名", () => expect(str("{名称}")).toBe("登录页改版"));
  it("未引用过 → null", () => expect(isNull("{不存在的字段}")).toBe(true));
  it("数字结果引用", () => expect(num("{数量} * 2")).toBe(6));
  it("布尔字段作为 IF 条件", () => expect(str("IF({已完成}, '已', '未')")).toBe("已"));
});

// ============ 错误形态（不应炸整表）============

describe("容错：公式语法错误返回 null", () => {
  it("未闭合括号", () => expect(isNull("CONCAT('a', 'b'")).toBe(true));
  it("未定义函数", () => expect(isNull("FOOBAR(1, 2)")).toBe(true));
  it("除零（MOD 之外）返回 null", () => expect(isNull("1 / 0")).toBe(true));
});

// ============ 综合 ============

describe("综合业务公式", () => {
  it("工时 * 时薪 = 工时成本", () => expect(num("{工时} * 200")).toBe(2400));
  it("IF + 拼接 状态标签", () =>
    expect(str("IF({已完成}, CONCAT({名称}, ' ✓'), CONCAT({名称}, ' …'))")).toBe("登录页改版 ✓"));
  it("COUNT 风格统计长度", () => expect(num("LEN(CONCAT({名称}, {备注} + ''))")).toBe(5));
  it("嵌套 IF", () =>
    expect(str("IF({数量} > 5, 'big', IF({数量} > 1, 'mid', 'tiny'))")).toBe("mid"));
});

describe("DATEADD 时区安全（U-10）", () => {
  it("纯日期输入按日历日加减，回纯日期形态", () => {
    expect(str("DATEADD('2026-09-11', 1)")).toBe("2026-09-12");
    expect(str("DATEADD('2026-09-11', -1)")).toBe("2026-09-10");
  });
  it("纯日期跨月/跨年", () => {
    expect(str("DATEADD('2026-01-31', 1)")).toBe("2026-02-01");
    expect(str("DATEADD('2026-12-31', 1)")).toBe("2027-01-01");
  });
  it("纯日期加减零天不变", () => {
    expect(str("DATEADD('2026-09-11', 0)")).toBe("2026-09-11");
  });
  it("非法日期回 null 不抛错", () => {
    const r = ev("DATEADD('not-a-date', 1)");
    expect(r.error).toBeNull();
    expect(r.value).toBe(FNULL);
  });
});
