// M1/S0 Characterization：queryRecords 返回形状与逐行值
//
// 锁 recordService.queryRecords 现状契约（recordService.ts:54-155），供 M1 S6/S7
// 改走 sidecar 下推 / keyset 后对拍：
//   - total（全表活记录数，过滤前）/ filteredTotal（过滤+搜索后、分页前）口径
//   - 默认顺序 (createdAt ASC, id ASC)（DB 层排序）
//   - groups：key/label/color/recordIds 精确值与顺序（选项序 / 空白桶最后 / 多选一桶一记录）
//   - aggregations 表尾数值（分页前全量）
//   - 内存 sort 空值恒后；假分页 slice 只切 records
//   - collapsedGroupKeys 当前不影响分组结果（现状怪癖，钉死）
//
// 不修正任何现状行为。单选用 optionId 存储，由此带出的「group label=optionId 原文、
// color 匹配 name 失败为 null」也如实记录。夹具见 _recordServiceFixture.ts。

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  T1, FIELDS, standardRows, recordFindMany,
  type FakeRow,
} from "./_recordServiceFixture.js";

// vi.mock 工厂被提升，无法直接引用外层 let；用 vi.hoisted 建可变状态载体。
const state = vi.hoisted(() => ({ rows: [] as FakeRow[] }));

vi.mock("../../../db.js", () => ({
  prisma: {
    record: { findMany: (args: { where?: { tableId?: string; deletedAt?: unknown } }) => recordFindMany(state.rows, args) },
    // 本片只用物理字段，hydration 不触发 field/linkRow/user 查询；给最小桩防 undefined。
    field: { findMany: () => Promise.resolve([]) },
    linkRow: { findMany: () => Promise.resolve([]), count: () => Promise.resolve(0) },
    user: { findUnique: () => Promise.resolve(null) },
  },
}));

const { queryRecords, parseViewConfig } = await import("../../recordService.js");

async function query(
  configOver: Partial<ReturnType<typeof parseViewConfig>> = {},
  limit?: number,
  offset?: number,
) {
  return await queryRecords({
    tableId: T1,
    fields: FIELDS,
    config: { ...parseViewConfig(null), ...configOver },
    limit,
    offset,
  });
}

beforeEach(() => {
  state.rows = standardRows();
});

describe("形状与口径", () => {
  it("返回五字段契约，groups/aggregations 默认 null", async () => {
    const r = await query();
    expect(Object.keys(r).sort()).toEqual(["aggregations", "filteredTotal", "groups", "records", "total"]);
    expect(r.groups).toBeNull();
    expect(r.aggregations).toBeNull();
  });

  it("total=活记录数（过滤前，不含软删），默认 (createdAt,id) 序", async () => {
    const r = await query();
    expect(r.total).toBe(4);
    expect(r.filteredTotal).toBe(4);
    expect(r.records.map((x) => x.id)).toEqual(["r1", "r2", "r3", "r4"]);
  });

  it("逐行 fields 为物理值或 null；HydratedRecord 七键与 ISO 时间", async () => {
    const r = await query();
    const r1 = r.records[0]!;
    expect(r1.fields.f_name).toBe("甲");
    expect(r1.fields.f_age).toBe(10);
    expect(r.records[3]!.fields.f_age).toBeNull();
    expect(Object.keys(r1).sort()).toEqual(
      ["createdAt", "createdBy", "fields", "id", "tableId", "updatedAt", "updatedBy"],
    );
    expect(r1.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(r1.createdBy).toBeNull();
  });
});

describe("过滤与搜索口径", () => {
  it("filters 只改 filteredTotal/records，不改 total", async () => {
    const r = await query({ filters: { kind: "condition", fieldId: "f_status", op: "is", value: "s_todo" } });
    expect(r.total).toBe(4);
    expect(r.filteredTotal).toBe(2);
    expect(r.records.map((x) => x.id)).toEqual(["r1", "r2"]);
  });

  it("config.search 对可见物理字段 contains（trim）", async () => {
    const r = await query({ search: " 甲 " });
    expect(r.filteredTotal).toBe(1);
    expect(r.records[0]!.id).toBe("r1");
  });
});

describe("排序（内存，空值恒后）", () => {
  it("数字 asc / desc：空值都排最后", async () => {
    const asc = await query({ sorts: [{ fieldId: "f_age", direction: "asc" }] });
    expect(asc.records.map((x) => x.id)).toEqual(["r1", "r2", "r3", "r4"]);
    const desc = await query({ sorts: [{ fieldId: "f_age", direction: "desc" }] });
    expect(desc.records.map((x) => x.id)).toEqual(["r3", "r2", "r1", "r4"]);
  });
});

describe("分组（精确 key/label/color/recordIds/顺序）", () => {
  it("singleSelect：options 序排桶、空白桶最后；label=optionId、color=null（现状）", async () => {
    const r = await query({ groupByFieldId: "f_status" });
    const g = r.groups!;
    expect(g.map((x) => x.key)).toEqual(["val:s_todo", "val:s_done", "__empty__"]);
    expect(g[0]!.label).toBe("s_todo");
    expect(g[0]!.color).toBeNull();
    expect(g[0]!.recordIds).toEqual(["r1", "r2"]);
    expect(g[2]!.label).toBe("(空白)");
    expect(g[2]!.recordIds).toEqual(["r4"]);
  });

  it("multiSelect：一记录进多桶、按首次出现序、空数组与 null 进空白桶去重", async () => {
    const r = await query({ groupByFieldId: "f_tags" });
    const byKey = new Map(r.groups!.map((x) => [x.key, x]));
    expect(byKey.get("opt:t_a")!.recordIds).toEqual(["r1"]);
    expect(byKey.get("opt:t_b")!.recordIds).toEqual(["r1", "r3"]);
    expect(byKey.get("opt:t_a")!.color).toBeNull();
    const last = r.groups![r.groups!.length - 1]!;
    expect(last.key).toBe("__empty__");
    expect(last.recordIds.sort()).toEqual(["r2", "r4"]);
  });

  it("checkbox：true 桶在前，固定中文 label 与硬编码颜色", async () => {
    const r = await query({ groupByFieldId: "f_check" });
    const g = r.groups!;
    expect(g.map((x) => x.key)).toEqual(["true", "false"]);
    expect(g[0]!.label).toBe("已勾选");
    expect(g[0]!.color).toBe("#1D9E75");
    expect(g[0]!.recordIds.sort()).toEqual(["r2", "r3"]);
    expect(g[1]!.label).toBe("未勾选");
    expect(g[1]!.color).toBe("#888780");
    expect(g[1]!.recordIds.sort()).toEqual(["r1", "r4"]);
  });

  it("现状怪癖：collapsedGroupKeys 非空时分组仍照常计算", async () => {
    const r = await query({ groupByFieldId: "f_status", collapsedGroupKeys: ["val:s_todo"] });
    expect(r.groups!.map((x) => x.key)).toEqual(["val:s_todo", "val:s_done", "__empty__"]);
  });
});

describe("聚合（表尾，分页前全量）", () => {
  it("sum/count 精确值（null 不计数值但计入 count 基数）", async () => {
    const r = await query({ aggregations: { f_age: "sum", f_name: "count" } });
    expect(r.aggregations).toEqual({ f_age: 60, f_name: 4 });
  });

  it("countEmpty/countFilled", async () => {
    const r = await query({ aggregations: { f_age: "countEmpty", f_status: "countFilled" } });
    expect(r.aggregations).toEqual({ f_age: 1, f_status: 3 });
  });

  it("分组桶聚合按桶内 recordIds；空白桶 null 年龄 sum=null", async () => {
    const r = await query({ groupByFieldId: "f_status", aggregations: { f_age: "sum" } });
    const byKey = new Map(r.groups!.map((x) => [x.key, x.aggregations]));
    expect(byKey.get("val:s_todo")).toEqual({ f_age: 30 });
    expect(byKey.get("val:s_done")).toEqual({ f_age: 30 });
    expect(byKey.get("__empty__")).toEqual({ f_age: null });
  });
});

describe("假分页（内存 slice）", () => {
  it("limit/offset 只切 records，total/filteredTotal/groups/aggregations 仍全量口径", async () => {
    const r = await query({ groupByFieldId: "f_status", aggregations: { f_age: "sum" } }, 2, 1);
    expect(r.records.map((x) => x.id)).toEqual(["r2", "r3"]);
    expect(r.total).toBe(4);
    expect(r.filteredTotal).toBe(4);
    expect(r.groups!.map((x) => x.key)).toEqual(["val:s_todo", "val:s_done", "__empty__"]);
    expect(r.aggregations).toEqual({ f_age: 60 });
  });
});
