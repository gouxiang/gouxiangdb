// apps/web/src/features/cells/format.test.ts
// 数字类单元格显示口径回归（node 环境纯函数单测，仓库无 jsdom / testing-library）。
//
// 缺陷：字段没配 precision 时，formatCell 用 `field.precision ?? 0` 兜底成 0 位小数，
// 于是存储的 -3.5 被显示成 -4 —— 用户会以为自己存的数被改了（后端实存就是 -3.5）。
// 口径修正是：precision 为数字（含 0）按它格式化；precision 为 null/undefined 走数字自然形式。

import { describe, expect, it } from "vitest";
import type { FieldDTO, FieldIdT, TableIdT } from "@gx/shared-types";
import { formatCell } from "./format";

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
