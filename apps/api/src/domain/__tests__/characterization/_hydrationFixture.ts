// M1/S0 characterization 共享夹具：多表 hydration 复杂场景（不含 vi.mock，纯内存 deps）
//
// 供 hydration.batch-parity / hydration 取数批次两个特征测试复用：
//   部门表 + 员工表；员工带 正向 links(bt→dept)、同表自引用(hm 正/反)、
//   lookup / rollup(sum) / count / 链式公式 / 跨表点引用公式；X/Y 双向点引用环。

import type { HydrateDeps, LinkRowRef } from "../../hydrate.js";
import type { FieldMeta, RawRecord, FieldValue } from "../../types.js";

export const T = { dept: "t_dept", emp: "t_emp", x: "t_x", y: "t_y" } as const;

export function fp(
  p: Partial<FieldMeta> & Pick<FieldMeta, "id" | "tableId" | "name" | "type" | "order">,
): FieldMeta {
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
  } as FieldMeta;
}

// ---- 部门表 ----
export const D_NAME = "d_name";
export const D_BUDGET = "d_budget";
export const D_STAFF = "d_staff";
export const deptFields: FieldMeta[] = [
  fp({ id: D_NAME, tableId: T.dept, name: "部门名", type: "singleLineText", order: 0 }),
  fp({ id: D_BUDGET, tableId: T.dept, name: "预算", type: "number", order: 1, precision: 0 }),
  fp({
    id: D_STAFF, tableId: T.dept, name: "员工（反向）", type: "links", order: 2,
    relatedTableId: T.emp, relationKind: "hm", isReverse: true,
    reverseFieldId: "e_dept", linkFieldId: "e_dept", linkDisplayFieldId: "e_name",
  }),
];

// ---- 员工表 ----
export const E_NAME = "e_name";
export const E_SAL = "e_sal";
export const E_DEPT = "e_dept";
export const E_MGR = "e_mgr";
export const E_REPORTS = "e_reports";
export const E_DEPTNAME = "e_deptname";
export const E_DEPTSUM = "e_deptsum";
export const E_DEPTCOUNT = "e_deptcount";
export const E_T = "e_t";
export const E_T2 = "e_t2";
export const E_DOT = "e_dot";
export const empFields: FieldMeta[] = [
  fp({ id: E_NAME, tableId: T.emp, name: "姓名", type: "singleLineText", order: 0 }),
  fp({ id: E_SAL, tableId: T.emp, name: "薪资", type: "number", order: 1, precision: 0 }),
  fp({
    id: E_DEPT, tableId: T.emp, name: "部门", type: "links", order: 2,
    relatedTableId: T.dept, relationKind: "bt", linkDisplayFieldId: D_NAME,
  }),
  fp({
    id: E_MGR, tableId: T.emp, name: "下属", type: "links", order: 3,
    relatedTableId: T.emp, relationKind: "hm", linkDisplayFieldId: E_NAME,
  }),
  fp({
    id: E_REPORTS, tableId: T.emp, name: "上级（反向）", type: "links", order: 4,
    relatedTableId: T.emp, relationKind: "hm", isReverse: true,
    reverseFieldId: E_MGR, linkFieldId: E_MGR, linkDisplayFieldId: E_NAME,
  }),
  fp({ id: E_DEPTNAME, tableId: T.emp, name: "部门名查找", type: "lookup", order: 5, linkFieldId: E_DEPT, lookupFieldId: D_NAME }),
  fp({ id: E_DEPTSUM, tableId: T.emp, name: "预算汇总", type: "rollup", order: 6, linkFieldId: E_DEPT, lookupFieldId: D_BUDGET, rollupFunction: "sum" }),
  fp({ id: E_DEPTCOUNT, tableId: T.emp, name: "部门数", type: "count", order: 7, linkFieldId: E_DEPT }),
  fp({ id: E_T, tableId: T.emp, name: "合成", type: "formula", order: 8, formula: "CONCAT({姓名}, ':', {薪资})" }),
  fp({ id: E_T2, tableId: T.emp, name: "合成链", type: "formula", order: 9, formula: "CONCAT({合成}, '!')" }),
  fp({ id: E_DOT, tableId: T.emp, name: "部门预算点引用", type: "formula", order: 10, formula: "{部门.预算}" }),
];

// ---- 双向环表 X / Y ----
export const X_LINK = "x_link";
export const X_F = "x_f";
export const xFields: FieldMeta[] = [
  fp({ id: "x_name", tableId: T.x, name: "X名", type: "singleLineText", order: 0 }),
  fp({ id: X_LINK, tableId: T.x, name: "Y关联", type: "links", order: 1, relatedTableId: T.y, relationKind: "mm", linkDisplayFieldId: "y_name" }),
  fp({ id: X_F, tableId: T.x, name: "X环公式", type: "formula", order: 2, formula: "{Y关联.Y环公式}" }),
];
export const Y_LINK = "y_link";
export const Y_F = "y_f";
export const yFields: FieldMeta[] = [
  fp({ id: "y_name", tableId: T.y, name: "Y名", type: "singleLineText", order: 0 }),
  fp({ id: Y_LINK, tableId: T.y, name: "X关联", type: "links", order: 1, relatedTableId: T.x, relationKind: "mm", linkDisplayFieldId: "x_name" }),
  fp({ id: Y_F, tableId: T.y, name: "Y环公式", type: "formula", order: 2, formula: "{X关联.X环公式}" }),
];

export function rc(id: string, tableId: string, f: Record<string, FieldValue>): RawRecord {
  return {
    id, tableId, fields: f,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    createdBy: "u1",
    updatedBy: "u1",
  };
}

export function lr(id: string, linkFieldId: string, parentRowId: string, childRowId: string, ord: number): LinkRowRef {
  return { id, linkFieldId, parentRowId, childRowId, ord };
}

/** 构造标准夹具的记录 + linkRows（新数组，测试间隔离） */
export function buildStore(): { store: RawRecord[]; links: LinkRowRef[] } {
  const store: RawRecord[] = [
    rc("dept1", T.dept, { [D_NAME]: "研发部", [D_BUDGET]: 1000 }),
    rc("dept2", T.dept, { [D_NAME]: "市场部", [D_BUDGET]: 500 }),
    rc("emp1", T.emp, { [E_NAME]: "张三", [E_SAL]: 200 }),
    rc("emp2", T.emp, { [E_NAME]: "李四", [E_SAL]: 300 }),
    rc("emp3", T.emp, { [E_NAME]: "王五", [E_SAL]: 150 }),
    rc("x1", T.x, { x_name: "X1" }),
    rc("y1", T.y, { y_name: "Y1" }),
  ];
  const links: LinkRowRef[] = [
    lr("lk1", E_DEPT, "emp1", "dept1", 0),
    lr("lk2", E_DEPT, "emp2", "dept1", 0),
    lr("lk3", E_DEPT, "emp3", "dept2", 0),
    lr("lk4", E_MGR, "emp1", "emp2", 0),
    lr("lk5", E_MGR, "emp1", "emp3", 1),
    lr("lk6", X_LINK, "x1", "y1", 0),
    lr("lk7", Y_LINK, "y1", "x1", 0),
  ];
  return { store, links };
}

export interface Counts {
  getFields: number;
  getRecordsByIds: number;
  getLinkRows: number;
  countLinkRows: number;
  getRecordOrdinal: number;
  resolveUserName: number;
  recordBatchSizes: number[];
  linkBatchSizes: number[];
}

/** 计数版内存 deps：记录每种取数调用次数与批大小（刻画改造前 N+1） */
export function countingDeps(store: RawRecord[], links: LinkRowRef[]): HydrateDeps & { counts: Counts } {
  const counts: Counts = {
    getFields: 0, getRecordsByIds: 0, getLinkRows: 0, countLinkRows: 0,
    getRecordOrdinal: 0, resolveUserName: 0, recordBatchSizes: [], linkBatchSizes: [],
  };
  const fieldsOf = (tableId: string): FieldMeta[] =>
    tableId === T.dept ? deptFields : tableId === T.emp ? empFields : tableId === T.x ? xFields : yFields;
  return {
    counts,
    async getFields(tableId) {
      counts.getFields++;
      return fieldsOf(tableId);
    },
    async getRecordsByIds(ids) {
      counts.getRecordsByIds++;
      counts.recordBatchSizes.push(ids.length);
      return store.filter((r) => ids.includes(r.id));
    },
    async getLinkRows(q) {
      counts.getLinkRows++;
      const hit = links.filter(
        (l) =>
          (!q.linkFieldId || l.linkFieldId === q.linkFieldId) &&
          (!q.parentRowId || l.parentRowId === q.parentRowId) &&
          (!q.childRowId || l.childRowId === q.childRowId),
      );
      counts.linkBatchSizes.push(hit.length);
      return hit;
    },
    async countLinkRows() {
      counts.countLinkRows++;
      return 0;
    },
    async getRecordOrdinal() {
      counts.getRecordOrdinal++;
      return 0;
    },
    async resolveUserName(userId) {
      counts.resolveUserName++;
      return userId === "u1" ? "老板" : userId;
    },
  };
}
