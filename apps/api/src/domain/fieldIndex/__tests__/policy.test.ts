// apps/api/src/domain/fieldIndex/__tests__/policy.test.ts
// M1/S4 policy 纯函数单测：锁死哪些字段入 sidecar，以及各类型存储值 → entries 的抽取口径。
// 与 shared-types/filter.ts 的日期/数字归一保持一致；多选摊平 ord；空值 isNull=1（RC-29 草稿）。

import { describe, expect, it } from "vitest";
import { FIELD_TYPES, fieldTypeGroup } from "@gx/shared-types";
import { extractEntries, isIndexedField, isNumericIndexType } from "../policy.js";

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
      "member",
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

// S6-1 单一事实源守卫（S4 欠账）：sidecar policy 的数值集合必须与 shared
// type-groups 的 number 分组逐类型一致。shared 的 NUMBER_TYPES 未导出，
// 用 fieldTypeGroup(t)==='number' 在【全部】FieldType 上反推，任何一侧
// 增删数值类型（rating 漂移那类事故）本测试立即红，从根上锁死两个事实源。
describe("类型一致性：policy 数值集合 == shared type-groups number 分组", () => {
  it("对全部 FieldType 逐类型判定，两侧集合完全相等", () => {
    const policyNumeric: string[] = [];
    const sharedNumeric: string[] = [];
    for (const t of FIELD_TYPES) {
      if (isNumericIndexType(t)) policyNumeric.push(t);
      if (fieldTypeGroup(t) === "number") sharedNumeric.push(t);
    }
    // 两侧成员集合严格相等（顺序无关），并显式锁死当前五个成员，
    // 使新增数值类型时必须同时改两边并主动更新此断言。
    expect(new Set(policyNumeric)).toEqual(new Set(sharedNumeric));
    expect(new Set(policyNumeric)).toEqual(
      new Set(["number", "currency", "percent", "duration", "rating"]),
    );
  });

  it("非数值类型一律不进 valueNum 数值组（防误纳）", () => {
    for (const t of FIELD_TYPES) {
      if (fieldTypeGroup(t) !== "number") {
        expect(isNumericIndexType(t), t).toBe(false);
      }
    }
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

  it("rating：归数值组，valueNum=数字且 valueText 留档（S6 范围算子命中 valueNum）", () => {
    const four = extractEntries(meta("rating"), 4)[0]!;
    expect(four).toMatchObject({ valueNum: 4, valueText: "4", isNull: 0 });
    // 0 星不是空（区别于未评分 null）：valueNum=0、isNull=0，不能误判为 NULL 桶
    const zero = extractEntries(meta("rating"), 0)[0]!;
    expect(zero).toMatchObject({ valueNum: 0, valueText: "0", isNull: 0 });
    // 字符串数字也能转
    expect(extractEntries(meta("rating"), "3")[0]).toMatchObject({ valueNum: 3 });
    // 未评分（null/空串）才进 NULL 桶
    expect(extractEntries(meta("rating"), null)[0]).toMatchObject({ isNull: 1, valueNum: null });
  });

  it("autoNumber：只入文本（可能是带前缀拼接串），valueNum 恒 null", () => {
    expect(extractEntries(meta("autoNumber"), "ORD-202609-0001")[0]).toMatchObject({
      valueText: "ORD-202609-0001",
      valueNum: null,
    });
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
