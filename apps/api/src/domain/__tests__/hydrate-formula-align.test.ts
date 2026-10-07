// apps/api/src/domain/__tests__/hydrate-formula-align.test.ts
// 点引用保位的 hydrate 集成测试：同一子表格字段的多个点引用（状态、金额）必须等长、
// 下标对应同一条子记录。经真实 hydrateRecords 路径验证 SUMIF/COUNTIF/AVERAGEIF
// 在中间子记录缺金额/缺状态时不错位，以及 SUM/AVERAGE 既有口径零回归。

import { describe, it, expect } from "vitest";
import { hydrateRecords, type HydrateDeps, type LinkRowRef } from "../hydrate.js";
import type { FieldMeta, RawRecord, FieldValue } from "../types.js";

const F = {
  parentName: "f_parent_name",
  detail: "f_detail",
  paidSum: "f_paid_sum",
  paidCount: "f_paid_count",
  paidAvg: "f_paid_avg",
  allSum: "f_all_sum",
  childStatus: "f_child_status",
  childAmount: "f_child_amount",
} as const;

const T = { parent: "t_parent", child: "t_child" } as const;

function field(p: Partial<FieldMeta> & Pick<FieldMeta, "id" | "tableId" | "name" | "type" | "order">): FieldMeta {
  return {
    description: "",
    required: false,
    unique: false,
    options: null,
    precision: null,
    maxLength: null,
    defaultNow: false,
    recordFilter: null,
    linkFieldId: null,
    relatedTableId: null,
    relationKind: null,
    isReverse: false,
    reverseFieldId: null,
    linkDisplayFieldId: null,
    lookupFieldId: null,
    rollupFunction: null,
    formula: null,
    tabsConfig: null,
    displayedFieldIds: null,
    visibleFieldIds: null,
    defaultConfig: null,
    numberRule: null,
    ...p,
  };
}

const parentFields: FieldMeta[] = [
  field({ id: F.parentName, tableId: T.parent, name: "名称", type: "singleLineText", order: 0 }),
  field({
    id: F.detail, tableId: T.parent, name: "明细", type: "subtable", order: 1,
    relatedTableId: T.child, relationKind: "hm", linkDisplayFieldId: F.childStatus,
  }),
  field({
    id: F.paidSum, tableId: T.parent, name: "已付金额", type: "formula", order: 2,
    formula: 'SUMIF({明细.状态}, "已付款", {明细.金额})',
  }),
  field({
    id: F.paidCount, tableId: T.parent, name: "已付条数", type: "formula", order: 3,
    formula: 'COUNTIF({明细.状态}, "已付款")',
  }),
  field({
    id: F.paidAvg, tableId: T.parent, name: "已付均额", type: "formula", order: 4,
    formula: 'AVERAGEIF({明细.状态}, "已付款", {明细.金额})',
  }),
  field({
    id: F.allSum, tableId: T.parent, name: "金额合计", type: "formula", order: 5,
    formula: "SUM({明细.金额})",
  }),
];

const childFields: FieldMeta[] = [
  field({ id: F.childStatus, tableId: T.child, name: "状态", type: "singleLineText", order: 0 }),
  field({ id: F.childAmount, tableId: T.child, name: "金额", type: "number", order: 1 }),
];

function rec(id: string, tableId: string, fields: Record<string, FieldValue>): RawRecord {
  return {
    id, tableId, fields,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    createdBy: "u_admin",
    updatedBy: "u_admin",
  };
}

function depsFor(children: RawRecord[]): HydrateDeps {
  const linkRows: LinkRowRef[] = children.map((c, i) => ({
    id: `l${i}`, linkFieldId: F.detail, parentRowId: "r_parent", childRowId: c.id, ord: i,
  }));
  return {
    async getFields(tableId) {
      return tableId === T.parent ? parentFields : childFields;
    },
    async getRecordsByIds(ids) {
      const all = [rec("r_parent", T.parent, { [F.parentName]: "父单" }), ...children];
      return all.filter((r) => ids.includes(r.id));
    },
    async getLinkRows(q) {
      return linkRows.filter(
        (l) =>
          (!q.linkFieldId || l.linkFieldId === q.linkFieldId) &&
          (!q.parentRowId || l.parentRowId === q.parentRowId) &&
          (!q.childRowId || l.childRowId === q.childRowId),
      );
    },
    async countLinkRows(q) {
      return (await this.getLinkRows(q)).length;
    },
    async getRecordOrdinal() {
      return 1;
    },
    async resolveUserName(uid) {
      return uid;
    },
  };
}

describe("hydrate 点引用保位 —— 条件聚合下标对齐", () => {
  it("中间子记录缺金额：不错位，已付金额只累加命中行的有效数值", async () => {
    // 三条子记录：已付款100 / 待付款(无金额) / 已付款50
    const children = [
      rec("c1", T.child, { [F.childStatus]: "已付款", [F.childAmount]: 100 }),
      rec("c2", T.child, { [F.childStatus]: "待付款" }),
      rec("c3", T.child, { [F.childStatus]: "已付款", [F.childAmount]: 50 }),
    ];
    const [out] = await hydrateRecords(
      [rec("r_parent", T.parent, {})],
      parentFields,
      depsFor(children),
    );
    expect(out!.fields[F.paidSum]).toBe(150);
    expect(out!.fields[F.paidCount]).toBe(2);
    expect(out!.fields[F.paidAvg]).toBe(75);
    // SUM 零回归：中间缺值被过滤，100+50
    expect(out!.fields[F.allSum]).toBe(150);
  });

  it("中间子记录缺状态：FNULL 占位，兄弟列表不错位（保位前会错算成 100+200）", async () => {
    const children = [
      rec("c1", T.child, { [F.childStatus]: "已付款", [F.childAmount]: 100 }),
      rec("c2", T.child, { [F.childAmount]: 200 }),
      rec("c3", T.child, { [F.childStatus]: "已付款", [F.childAmount]: 50 }),
    ];
    const [out] = await hydrateRecords(
      [rec("r_parent", T.parent, {})],
      parentFields,
      depsFor(children),
    );
    // 保位后下标 0/2 命中 → 100+50；旧实现状态列表过滤 null 后 200 会错配到下标 1
    expect(out!.fields[F.paidSum]).toBe(150);
    expect(out!.fields[F.paidCount]).toBe(2);
    expect(out!.fields[F.allSum]).toBe(350); // SUM 与点引用保位无关，100+200+50
  });
});
