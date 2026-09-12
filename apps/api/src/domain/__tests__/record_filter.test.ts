// apps/api/src/domain/__tests__/record_filter.test.ts
// recordFilter 子集筛选：Rollup/Lookup/Count 在对面表上应用 FilterNode
// 对齐用户要求："选关联表→选关联字段→设筛选条件，满足条件的情况下才聚合计算"

import { describe, it, expect } from "vitest";
import { hydrateRecords, type HydrateDeps, type LinkRowRef } from "../hydrate.js";
import { evalFilter } from "../filter.js";
import type { FieldMeta, FieldValue, RawRecord } from "../types.js";
import type { FilterNode, FilterCondition } from "@gx/shared-types";

const F = {
  // Orders 表
  orderName: "f_order_name",
  orderAmount: "f_order_amount",
  orderCustomer: "f_order_customer", // links → customers (mm)
  orderPayerLevel: "f_order_payer_level", // lookup → customer.level（带 recordFilter）
  orderPaidAmount: "f_order_paid_amount", // rollup sum → customer.deposit
  orderPaidCount: "f_order_paid_count", // count（带 recordFilter: 只算 VIP）

  // Customers 表
  customerName: "f_customer_name",
  customerLevel: "f_customer_level", // singleSelect: normal / vip
  customerDeposit: "f_customer_deposit",
  customerOrders: "f_customer_orders", // 反向 links
} as const;

const T = { orders: "t_orders", customers: "t_customers" } as const;

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

const orderFields: FieldMeta[] = [
  field({ id: F.orderName, tableId: T.orders, name: "单号", type: "singleLineText", order: 0 }),
  field({ id: F.orderAmount, tableId: T.orders, name: "金额", type: "number", order: 1, precision: 0 }),
  field({
    id: F.orderCustomer,
    tableId: T.orders,
    name: "客户",
    type: "links",
    order: 2,
    relatedTableId: T.customers,
    relationKind: "mm",
    linkFieldId: F.customerOrders,
    linkDisplayFieldId: F.customerName,
  }),
  // lookup：只取 VIP 客户的职级
  field({
    id: F.orderPayerLevel,
    tableId: T.orders,
    name: "VIP 客户职级",
    type: "lookup",
    order: 3,
    linkFieldId: F.orderCustomer,
    lookupFieldId: F.customerLevel,
    recordFilter: { kind: "condition", fieldId: F.customerLevel, op: "is", value: "vip" } satisfies FilterNode,
  }),
  // rollup sum：只算 VIP 客户的押金
  field({
    id: F.orderPaidAmount,
    tableId: T.orders,
    name: "VIP 押金合计",
    type: "rollup",
    order: 4,
    linkFieldId: F.orderCustomer,
    lookupFieldId: F.customerDeposit,
    rollupFunction: "sum",
    recordFilter: { kind: "condition", fieldId: F.customerLevel, op: "is", value: "vip" } satisfies FilterNode,
  }),
  // count：只算 VIP 客户数
  field({
    id: F.orderPaidCount,
    tableId: T.orders,
    name: "VIP 客户数",
    type: "count",
    order: 5,
    linkFieldId: F.orderCustomer,
    recordFilter: { kind: "condition", fieldId: F.customerLevel, op: "is", value: "vip" } satisfies FilterNode,
  }),
];

const customerFields: FieldMeta[] = [
  field({ id: F.customerName, tableId: T.customers, name: "名称", type: "singleLineText", order: 0 }),
  field({ id: F.customerLevel, tableId: T.customers, name: "等级", type: "singleSelect", order: 1 }),
  field({ id: F.customerDeposit, tableId: T.customers, name: "押金", type: "number", order: 2, precision: 0 }),
  field({
    id: F.customerOrders,
    tableId: T.customers,
    name: "订单（反向）",
    type: "links",
    order: 3,
    relatedTableId: T.orders,
    relationKind: "mm",
    isReverse: true,
    reverseFieldId: F.orderCustomer,
    linkFieldId: F.orderCustomer,
    linkDisplayFieldId: F.orderName,
  }),
];

function rec(id: string, tableId: string, f: Record<string, FieldValue>): RawRecord {
  return {
    id,
    tableId,
    fields: f,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    createdBy: "u_admin",
    updatedBy: "u_admin",
  };
}

// 一个 order 关联三个客户：1 个普通 + 2 个 VIP
const records: RawRecord[] = [
  rec("r_order1", T.orders, { [F.orderName]: "ORD-001", [F.orderAmount]: 100 }),
  rec("r_cust_normal", T.customers, {
    [F.customerName]: "普通客",
    [F.customerLevel]: "normal",
    [F.customerDeposit]: 50,
  }),
  rec("r_cust_vip1", T.customers, {
    [F.customerName]: "VIP张",
    [F.customerLevel]: "vip",
    [F.customerDeposit]: 300,
  }),
  rec("r_cust_vip2", T.customers, {
    [F.customerName]: "VIP李",
    [F.customerLevel]: "vip",
    [F.customerDeposit]: 500,
  }),
];

const linkRows: LinkRowRef[] = [
  { id: "l1", linkFieldId: F.orderCustomer, parentRowId: "r_order1", childRowId: "r_cust_normal", ord: 0 },
  { id: "l2", linkFieldId: F.orderCustomer, parentRowId: "r_order1", childRowId: "r_cust_vip1", ord: 1 },
  { id: "l3", linkFieldId: F.orderCustomer, parentRowId: "r_order1", childRowId: "r_cust_vip2", ord: 2 },
];

function makeDeps(): HydrateDeps {
  const ordinals = new Map<string, string[]>([
    [T.orders, ["r_order1"]],
    [T.customers, ["r_cust_normal", "r_cust_vip1", "r_cust_vip2"]],
  ]);
  return {
    async getFields(tableId) {
      return tableId === T.orders ? orderFields : customerFields;
    },
    async getRecordsByIds(ids) {
      return records.filter((r) => ids.includes(r.id));
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
      return linkRows.filter(
        (l) =>
          (!q.linkFieldId || l.linkFieldId === q.linkFieldId) &&
          (!q.parentRowId || l.parentRowId === q.parentRowId) &&
          (!q.childRowId || l.childRowId === q.childRowId),
      ).length;
    },
    async getRecordOrdinal(tableId, recordId) {
      return (ordinals.get(tableId) ?? []).indexOf(recordId) + 1;
    },
    async resolveUserName(userId) {
      return userId;
    },
  };
}

describe("recordFilter 在 Rollup/Lookup/Count 上生效", () => {
  it("lookup 应用 recordFilter：只取 VIP 客户的职级", async () => {
    const deps = makeDeps();
    const [order] = await hydrateRecords([records[0]!], orderFields, deps);
    expect(order!.fields[F.orderPayerLevel]).toEqual(["vip", "vip"]);
  });

  it("rollup sum 应用 recordFilter：只累加 VIP 押金（300+500=800）", async () => {
    const deps = makeDeps();
    const [order] = await hydrateRecords([records[0]!], orderFields, deps);
    expect(order!.fields[F.orderPaidAmount]).toBe(800);
  });

  it("count 应用 recordFilter：只数 VIP 客户（2 个）", async () => {
    const deps = makeDeps();
    const [order] = await hydrateRecords([records[0]!], orderFields, deps);
    expect(order!.fields[F.orderPaidCount]).toBe(2);
  });

  it("无 recordFilter 时是全集：sum 含普通客户押金（50+300+500=850）", async () => {
    const noFilter = orderFields.map((f) =>
      f.id === F.orderPaidAmount ? { ...f, recordFilter: null } : f,
    );
    const deps = makeDeps();
    const [order] = await hydrateRecords([records[0]!], noFilter, deps);
    expect(order!.fields[F.orderPaidAmount]).toBe(850);
  });

  it("复合 recordFilter（and）：押金≥100 且 VIP", async () => {
    const compound: FilterNode = {
      kind: "and",
      children: [
        { kind: "condition", fieldId: F.customerLevel, op: "is", value: "vip" },
        { kind: "condition", fieldId: F.customerDeposit, op: "gte", value: "100" },
      ],
    };
    const fields = orderFields.map((f) =>
      f.id === F.orderPaidAmount
        ? { ...f, recordFilter: compound as unknown }
        : f,
    );
    const deps = makeDeps();
    const [order] = await hydrateRecords([records[0]!], fields, deps);
    // 满足：VIP张300 + VIP李500 = 800（都不低于 100；普通客 50 排除）
    expect(order!.fields[F.orderPaidAmount]).toBe(800);
  });
});

describe("contains/notContains 对数组值的语义（v2 修正）", () => {
  const fid = "f_tags";
  // 模拟对面记录：f_tags 字段存 multiSelect option id 数组
  const r1: RawRecord = { id: "r1", tableId: "t", fields: { [fid]: ["opt_vip_custom"] }, createdAt: "x", updatedAt: "x", createdBy: "u", updatedBy: "u" };
  const r2: RawRecord = { id: "r2", tableId: "t", fields: { [fid]: ["opt_normal"] }, createdAt: "x", updatedAt: "x", createdBy: "u", updatedBy: "u" };
  const r3: RawRecord = { id: "r3", tableId: "t", fields: { [fid]: [] }, createdAt: "x", updatedAt: "x", createdBy: "u", updatedBy: "u" };
  const r4: RawRecord = { id: "r4", tableId: "t", fields: {}, createdAt: "x", updatedAt: "x", createdBy: "u", updatedBy: "u" };

  const cond = (op: FilterCondition["op"], value: string): FilterCondition => ({
    kind: "condition", fieldId: fid, op, value,
  });

  // RawRecord.fields 是 unknown；helper 把字段对象 narrow 成 Record<string, unknown> 后再返回 evaluator，
  // 让 evalFilter 的 get 形参(contextually typed `(id: string) => unknown`)能被 TS strict 通过
  const getterFor = (r: RawRecord) => {
    const obj = (r.fields ?? {}) as Record<string, unknown>;
    return (id: string): unknown => (id === fid ? obj[id] : null);
  };

  it("multiSelect 数组 contains 命中子串（v2 行为）：VIP 是 opt_vip_custom 的子串 → true", () => {
    expect(evalFilter(cond("contains", "VIP"), getterFor(r1))).toBe(true);
  });

  it("multiSelect 数组 contains 不命中：normal 客户", () => {
    expect(evalFilter(cond("contains", "VIP"), getterFor(r2))).toBe(false);
  });

  it("multiSelect 数组 contains 空数组 → false", () => {
    expect(evalFilter(cond("contains", "VIP"), getterFor(r3))).toBe(false);
  });

  it("multiSelect 数组 contains 字段不存在 → false", () => {
    expect(evalFilter(cond("contains", "VIP"), getterFor(r4))).toBe(false);
  });

  it("multiSelect 数组 notContains 与 contains 互斥", () => {
    expect(evalFilter(cond("notContains", "VIP"), getterFor(r1))).toBe(false);
    expect(evalFilter(cond("notContains", "VIP"), getterFor(r2))).toBe(true);
  });

  it("LinkRef[] 数组 contains 命中 title 子串", () => {
    const linkRec: RawRecord = {
      id: "r5", tableId: "t",
      fields: { [fid]: [{ tableId: "x", recordId: "1", title: "客户A-VIP" }, { tableId: "x", recordId: "2", title: "客户B-普通" }] },
      createdAt: "x", updatedAt: "x", createdBy: "u", updatedBy: "u",
    };
    expect(evalFilter(cond("contains", "VIP"), getterFor(linkRec))).toBe(true);
  });

  it("isAnyOf 对 multiSelect 数组仍是精确匹配（不变语义）", () => {
    const a: RawRecord = { id: "a", tableId: "t", fields: { [fid]: ["VIP"] }, createdAt: "x", updatedAt: "x", createdBy: "u", updatedBy: "u" };
    const b: RawRecord = { id: "b", tableId: "t", fields: { [fid]: ["vip"] }, createdAt: "x", updatedAt: "x", createdBy: "u", updatedBy: "u" };
    // 大小写不敏感（对齐 v1）
    expect(evalFilter(cond("isAnyOf", "VIP,gold"), getterFor(a))).toBe(true);
    expect(evalFilter(cond("isAnyOf", "VIP,gold"), getterFor(b))).toBe(true);
    // 子串不应误命中
    const c: RawRecord = { id: "c", tableId: "t", fields: { [fid]: ["VIP客户"] }, createdAt: "x", updatedAt: "x", createdBy: "u", updatedBy: "u" };
    expect(evalFilter(cond("isAnyOf", "VIP,gold"), getterFor(c))).toBe(false);
  });
});
