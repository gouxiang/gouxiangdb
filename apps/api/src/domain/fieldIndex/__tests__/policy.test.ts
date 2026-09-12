// apps/api/src/domain/fieldIndex/__tests__/policy.test.ts
// M1/S4 policy 纯函数单测：锁死哪些字段入 sidecar，以及各类型存储值 → entries 的抽取口径。
// 与 shared-types/filter.ts 的日期/数字归一保持一致；多选摊平 ord；空值 isNull=1（RC-29 草稿）。

import { describe, expect, it } from "vitest";
import { extractEntries, isIndexedField } from "../policy.js";

const meta = (type: string, id = "f", extra: { isPrimary?: boolean } = {}) => ({
  id,
  type,
  tableId: "t",
  ...extra,
});

describe("isIndexedField 字段准入矩阵", () => {
  it("文本/数值/日期/勾选/单选/多选入索引", () => {
    for (const t of [
      "singleLineText",
      "email",
      "url",
      "phone",
      "number",
      "currency",
      "percent",
      "duration",
      "rating",
      "autoNumber",
      "date",
      "datetime",
      "checkbox",
      "singleSelect",
      "multiSelect",
    ]) {
      expect(isIndexedField(meta(t)), t).toBe(true);
    }
  });

  it("正文/附件/关联/计算/系统字段排除", () => {
    for (const t of [
      "longText",
      "richText",
      "json",
      "attachment",
      "links",
      "subtable",
      "lookup",
      "rollup",
      "count",
      "formula",
      "tabs",
      "createdTime",
      "lastModifiedTime",
      "createdBy",
      "lastModifiedBy",
    ]) {
      expect(isIndexedField(meta(t)), t).toBe(false);
    }
  });

  it("主字段即便物理类型是 longText 也按文本入索引", () => {
    expect(isIndexedField(meta("longText", "primary", { isPrimary: true }))).toBe(true);
    // 但主字段若是计算/关联类型仍不索引
    expect(isIndexedField(meta("formula", "f", { isPrimary: true }))).toBe(false);
    expect(isIndexedField(meta("links", "f", { isPrimary: true }))).toBe(false);
  });
});

describe("extractEntries 各类型口径", () => {
  it("singleLineText：非空 → valueText，标量 ord=0", () => {
    expect(extractEntries(meta("singleLineText"), "hello")).toEqual([
      { fieldId: "f", valueText: "hello", valueNum: null, isNull: 0, ord: 0 },
    ]);
  });

  it("空串/null/undefined → isNull=1（RC-29 草稿空值）", () => {
    for (const v of ["", null, undefined]) {
      expect(extractEntries(meta("singleLineText"), v)).toEqual([
        { fieldId: "f", valueText: null, valueNum: null, isNull: 1, ord: 0 },
      ]);
    }
  });

  it("number：数字入 valueNum，文本数字可转，非数字串 valueNum=null 但 isNull=0", () => {
    expect(extractEntries(meta("number"), 42)[0]).toMatchObject({ valueNum: 42, valueText: "42", isNull: 0 });
    expect(extractEntries(meta("currency"), "12.5")[0]).toMatchObject({ valueNum: 12.5 });
    // 库存现状：字符串 "abc" 非空但转不出数 → valueNum=null，文本留档，不算 NULL 桶
    const e = extractEntries(meta("number"), "abc")[0]!;
    expect(e).toMatchObject({ valueNum: null, valueText: "abc", isNull: 0 });
    expect(extractEntries(meta("number"), null)[0]).toMatchObject({ isNull: 1 });
  });

  it("date/datetime：valueNum=Date.parse 毫秒，valueText 存原始串", () => {
    const e = extractEntries(meta("date"), "2026-09-13")[0]!;
    expect(e.valueNum).toBe(Date.parse("2026-09-13"));
    expect(e.valueText).toBe("2026-09-13");
    const dt = extractEntries(meta("datetime"), "2026-09-13T08:30:00Z")[0]!;
    expect(dt.valueNum).toBe(Date.parse("2026-09-13T08:30:00Z"));
  });

  it("checkbox：boolean → 0/1；空 → isNull；truthy/falsy 归一", () => {
    expect(extractEntries(meta("checkbox"), true)[0]).toMatchObject({ valueNum: 1 });
    expect(extractEntries(meta("checkbox"), false)[0]).toMatchObject({ valueNum: 0, isNull: 0 });
    expect(extractEntries(meta("checkbox"), null)[0]).toMatchObject({ isNull: 1 });
  });

  it("singleSelect：裸 optionId / 对象 id 都取 optionId", () => {
    expect(extractEntries(meta("singleSelect"), "opt_a")[0]).toMatchObject({ valueText: "opt_a", ord: 0 });
    expect(extractEntries(meta("singleSelect"), { id: "opt_b" })[0]).toMatchObject({ valueText: "opt_b" });
    expect(extractEntries(meta("singleSelect"), null)[0]).toMatchObject({ isNull: 1 });
  });

  it("multiSelect：每选项摊平一行，ord 为序号，valueText=optionId", () => {
    const rows = extractEntries(meta("multiSelect"), ["o1", "o2", "o3"]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.valueText, r.ord])).toEqual([
      ["o1", 0],
      ["o2", 1],
      ["o3", 2],
    ]);
    expect(rows.every((r) => r.isNull === 0 && r.valueNum === null)).toBe(true);
  });

  it("multiSelect：对象数组取 id；空数组 → 单行 isNull=1", () => {
    const rows = extractEntries(meta("multiSelect"), [{ id: "x" }, { recordId: "y" }]);
    expect(rows.map((r) => r.valueText)).toEqual(["x", "y"]);
    expect(extractEntries(meta("multiSelect"), [])[0]).toMatchObject({ isNull: 1 });
  });

  it("主字段 longText 按文本抽取", () => {
    const e = extractEntries(meta("longText", "p", { isPrimary: true }), "标题");
    expect(e[0]).toMatchObject({ valueText: "标题", valueNum: null });
  });

  it("未被索引类型（防御）返回空数组", () => {
    expect(extractEntries(meta("formula"), 123)).toEqual([]);
    expect(extractEntries(meta("links"), ["r1"])).toEqual([]);
  });
});
