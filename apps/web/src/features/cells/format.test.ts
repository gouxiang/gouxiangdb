// apps/web/src/features/cells/format.test.ts
// 数字类单元格显示口径回归（node 环境纯函数单测，仓库无 jsdom / testing-library）。
//
// 缺陷：字段没配 precision 时，formatCell 用 `field.precision ?? 0` 兜底成 0 位小数，
// 于是存储的 -3.5 被显示成 -4 —— 用户会以为自己存的数被改了（后端实存就是 -3.5）。
// 口径修正是：precision 为数字（含 0）按它格式化；precision 为 null/undefined 走数字自然形式。

import { describe, expect, it } from "vitest";
import type { FieldDTO, FieldIdT, TableIdT } from "@gx/shared-types";
import { formatCell, fmtDateTime, isIsoDatetimeLike } from "./format";

/** 最小 FieldDTO：只带格式化分支真正读取的键。 */
function mkField(patch: Partial<FieldDTO> = {}): FieldDTO {
  return {
    id: "f1" as FieldIdT,
    tableId: "t1" as TableIdT,
    name: "数值",
    type: "number",
    description: "",
    order: 1,
    required: false,
    unique: false,
    options: null,
    precision: null,
    linkFieldId: null,
    relatedTableId: null,
    relationKind: null,
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
    rollupFunction: null,
    recordFilter: null,
    formula: null,
    tabsConfig: null,
    displayedFieldIds: null,
    visibleFieldIds: null,
    defaultConfig: null,
    numberRule: null,
    ...patch,
  };
}

describe("formatCell：number 字段的精度口径", () => {
  it("precision 未设置（null）→ 不补位也不截位，-3.5 就显示 -3.5（能证伪：改回 ?? 0 会变 -4）", () => {
    // null：后端未配置精度的真实形态
    expect(formatCell(-3.5, mkField({ type: "number", precision: null }))).toBe("-3.5");
    // undefined：DTO 缺键的兜底形态
    expect(formatCell(-3.5, mkField({ type: "number", precision: undefined }))).toBe("-3.5");
    // 整数不补 .0
    expect(formatCell(42, mkField({ type: "number", precision: null }))).toBe("42");
    // 千分位仍然保留
    expect(formatCell(1234567.25, mkField({ type: "number", precision: null }))).toBe("1,234,567.25");
  });

  it("precision 显式设为 0 → 保持原来的取整行为（-3.5 → -4，防回归）", () => {
    expect(formatCell(-3.5, mkField({ type: "number", precision: 0 }))).toBe("-4");
    expect(formatCell(42, mkField({ type: "number", precision: 0 }))).toBe("42");
  });

  it("precision 显式设为 2 → 按两位小数补位/截位（3.14159 → 3.14，防回归）", () => {
    expect(formatCell(3.14159, mkField({ type: "number", precision: 2 }))).toBe("3.14");
    expect(formatCell(3, mkField({ type: "number", precision: 2 }))).toBe("3.00");
  });

  it("percent 分支与 number 同口径（null 不截位 / 0 取整 / 2 两位）", () => {
    expect(formatCell(-3.5, mkField({ type: "percent", precision: null }))).toBe("-3.5%");
    expect(formatCell(-3.5, mkField({ type: "percent", precision: 0 }))).toBe("-4%");
    expect(formatCell(3.14159, mkField({ type: "percent", precision: 2 }))).toBe("3.14%");
  });

  it("rating / duration 与 number 同口径，且非数字值仍返回空串（原有行为不变）", () => {
    expect(formatCell(4.5, mkField({ type: "rating", precision: null }))).toBe("4.5");
    expect(formatCell(1.5, mkField({ type: "duration", precision: null }))).toBe("1.5");
    expect(formatCell("abc", mkField({ type: "number", precision: null }))).toBe("");
    expect(formatCell(null, mkField({ type: "number", precision: null }))).toBe("");
  });

  it("currency 固定两位的行为未被本次改动波及", () => {
    expect(formatCell(12.3, mkField({ type: "currency", precision: null }))).toBe("¥12.30");
  });
});

// 缺陷：公式 NOW() 返回 new Date().toISOString()（2026-10-02T13:38:39.086Z），
// 而 formatCell 的 switch 里没有 formula 分支，落到 default 的 String(value) 整串直出。
// 秒是真实数据的一部分，截到分钟会让同一分钟内创建/更新的记录无法区分。
describe("fmtDateTime：时间口径带秒", () => {
  it("输出 YYYY-MM-DD HH:mm:ss（能证伪：截到分钟的实现会少 :ss 一段）", () => {
    expect(fmtDateTime("2026-10-02T13:38:39")).toBe("2026-10-02 13:38:39");
    // 个位时/分/秒补零
    expect(fmtDateTime("2026-01-05T09:07:03")).toBe("2026-01-05 09:07:03");
  });

  it("UTC ISO 串（NOW() 的真实输出形态）也格式化到秒", () => {
    // 落本地时区渲染，故只校验形态与秒段存在
    expect(fmtDateTime("2026-10-02T13:38:39.086Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(fmtDateTime("2026-10-02T13:38:39Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("date 字段仍只到日（fmtDate 口径未被波及）", () => {
    expect(formatCell("2026-10-02", mkField({ type: "date" }))).toBe("2026-10-02");
  });
});

describe("formatCell：formula / lookup 字段的时间串", () => {
  it("formula + ISO 串 → YYYY-MM-DD HH:mm:ss（不再整串直出）", () => {
    const f = mkField({ type: "formula" });
    expect(formatCell("2026-10-02T13:38:39", f)).toBe("2026-10-02 13:38:39");
    expect(formatCell("2026-10-02T13:38:39.086Z", f)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(formatCell("2026-10-02T13:38:39Z", f)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("formula + 普通文本/数字 → 原样返回，不被误格式化", () => {
    const f = mkField({ type: "formula" });
    expect(formatCell("已完成", f)).toBe("已完成");
    // 纯日期不是时间口径：不能补出 00:00:00
    expect(formatCell("2026-10-02", f)).toBe("2026-10-02");
    // 空格分隔（不带 T）的书写形态按原样保留
    expect(formatCell("2026-10-02 13:38:39", f)).toBe("2026-10-02 13:38:39");
    expect(formatCell(42, f)).toBe("42");
    expect(formatCell(true, f)).toBe("true");
  });

  it("lookup 字段与 formula 同口径（关联带回的时间串同样格式化）", () => {
    const f = mkField({ type: "lookup" });
    expect(formatCell("2026-10-02T13:38:39", f)).toBe("2026-10-02 13:38:39");
    expect(formatCell("北京", f)).toBe("北京");
  });
});

describe("isIsoDatetimeLike：时间形态识别", () => {
  it("纯日期 2026-10-02 不算时间（能证伪：缺长度/含 T 判定会误判）", () => {
    expect(isIsoDatetimeLike("2026-10-02")).toBe(false);
    expect(isIsoDatetimeLike("2026-10-02T13:3")).toBe(false);
  });

  it("四种真实时间形态都识别为时间", () => {
    expect(isIsoDatetimeLike("2026-10-02T13:38:39.086Z")).toBe(true);
    expect(isIsoDatetimeLike("2026-10-02T13:38:39Z")).toBe(true);
    expect(isIsoDatetimeLike("2026-10-02T13:38:39")).toBe(true);
    expect(isIsoDatetimeLike("2026-10-02T13:38")).toBe(true);
  });

  it("非字符串、空值、形似而非法的值一律 false（保守，宁可不格式化）", () => {
    expect(isIsoDatetimeLike(null)).toBe(false);
    expect(isIsoDatetimeLike(undefined)).toBe(false);
    expect(isIsoDatetimeLike(1780000000000)).toBe(false);
    expect(isIsoDatetimeLike(["2026-10-02T13:38:39"])).toBe(false);
    // 含 T 且够长，但日期非法（13 月 / 45 日）
    expect(isIsoDatetimeLike("2026-13-45T13:38:39")).toBe(false);
    expect(isIsoDatetimeLike("不是时间也不是日期串")).toBe(false);
  });
});
