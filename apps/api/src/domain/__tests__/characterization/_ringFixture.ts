// S5b-P1 点引用环 characterization 专用夹具（纯内存 deps，不依赖 DB）
//
// 图结构（对应 S5b 计划 §5 覆盖矩阵）：
//   R3 非对称点引用环：A 表 fa = {AB.fb}，B 表 fb = {BA.fa}；
//     a1↔b1 双向 link 成环；a0/b0 为与环无关的同表记录（第三起始态用）。
//   R4 钻石：P 表 p1、p2 经同一 links 字段 PD 汇聚到共享子记录 d1；
//     g1/g2 两个公式字段都点 {PD.dv}（同值汇聚）；d1 自身带 lookup dlup（→C.cv），
//     使 d1 的 merged 物化成本非平凡，便于黑盒计数 merged 次数。
//   R6 跨表环叠 lookup：环记录 a1 另有 links AC→c1，A 表 la 为 lookup(AC→cv)，
//     锁「点引用环置 null 不波及同记录无关 lookup」。
//   R7 链式首点：A 表 f7 = {AB.BC.cv}，B 表有 links BC→C 但无子字段名 "BC.cv"，
//     现状 buildFormulaSource 只切第一个点、subName="BC.cv" 找不到字段 → null。
//   双侧 null 环：X/Y 两表 xf={Y.yf}、yf={X.xf}，x1↔y1，两侧均 null。
//
// Characterization 纪律：本文件只描述数据，不断言对错；取值算法在 hydrate.ts，
// 本切片零改动。

import type { HydrateDeps, LinkRowRef } from "../../hydrate.js";
import type { FieldMeta, RawRecord, FieldValue } from "../../types.js";

export const RT = { a: "ring_a", b: "ring_b", c: "ring_c", p: "ring_p", d: "ring_d", x: "ring_x", y: "ring_y" } as const;

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

// ---- A 表 ----
export const A_NAME = "a_name";
export const A_NUM = "a_num";
export const A_AB = "ab";
export const A_AC = "ac";
export const A_FA = "fa";
export const A_LA = "la";
export const A_F7 = "f7";
export const aFields: FieldMeta[] = [
  fp({ id: A_NAME, tableId: RT.a, name: "A名", type: "singleLineText", order: 0 }),
  fp({ id: A_NUM, tableId: RT.a, name: "A数", type: "number", order: 1, precision: 0 }),
  fp({ id: A_AB, tableId: RT.a, name: "AB", type: "links", order: 2, relatedTableId: RT.b, relationKind: "mm", linkDisplayFieldId: "b_name" }),
  fp({ id: A_AC, tableId: RT.a, name: "AC", type: "links", order: 3, relatedTableId: RT.c, relationKind: "mm", linkDisplayFieldId: "c_name" }),
  fp({ id: A_FA, tableId: RT.a, name: "fa", type: "formula", order: 4, formula: "{AB.fb}" }),
  fp({ id: A_LA, tableId: RT.a, name: "la", type: "lookup", order: 5, linkFieldId: A_AC, lookupFieldId: "cv" }),
  fp({ id: A_F7, tableId: RT.a, name: "f7", type: "formula", order: 6, formula: "{AB.BC.cv}" }),
];

// ---- B 表 ----
export const B_NAME = "b_name";
export const B_NUM = "b_num";
export const B_BA = "ba";
export const B_BC = "bc";
export const B_FB = "fb";
export const bFields: FieldMeta[] = [
  fp({ id: B_NAME, tableId: RT.b, name: "B名", type: "singleLineText", order: 0 }),
  fp({ id: B_NUM, tableId: RT.b, name: "B数", type: "number", order: 1, precision: 0 }),
  fp({ id: B_BA, tableId: RT.b, name: "BA", type: "links", order: 2, relatedTableId: RT.a, relationKind: "mm", linkDisplayFieldId: "a_name" }),
  fp({ id: B_BC, tableId: RT.b, name: "BC", type: "links", order: 3, relatedTableId: RT.c, relationKind: "mm", linkDisplayFieldId: "c_name" }),
  fp({ id: B_FB, tableId: RT.b, name: "fb", type: "formula", order: 4, formula: "{BA.fa}" }),
];

// ---- C 表（环外叶子表，供 lookup / 链式指向） ----
export const C_NAME = "c_name";
export const C_CV = "cv";
export const cFields: FieldMeta[] = [
  fp({ id: C_NAME, tableId: RT.c, name: "C名", type: "singleLineText", order: 0 }),
  fp({ id: C_CV, tableId: RT.c, name: "cv", type: "number", order: 1, precision: 0 }),
];

// ---- P 表 / D 表（R4 钻石） ----
export const P_NAME = "p_name";
export const P_PD = "pd";
export const P_G1 = "g1";
export const P_G2 = "g2";
export const pFields: FieldMeta[] = [
  fp({ id: P_NAME, tableId: RT.p, name: "P名", type: "singleLineText", order: 0 }),
  fp({ id: P_PD, tableId: RT.p, name: "PD", type: "links", order: 1, relatedTableId: RT.d, relationKind: "mm", linkDisplayFieldId: "d_name" }),
  fp({ id: P_G1, tableId: RT.p, name: "g1", type: "formula", order: 2, formula: "{PD.dv}" }),
  fp({ id: P_G2, tableId: RT.p, name: "g2", type: "formula", order: 3, formula: "{PD.dv}" }),
];
export const D_NAME = "d_name";
export const D_DV = "dv";
export const D_DL = "dl";
export const D_DLUP = "dlup";
export const dFields: FieldMeta[] = [
  fp({ id: D_NAME, tableId: RT.d, name: "D名", type: "singleLineText", order: 0 }),
  fp({ id: D_DV, tableId: RT.d, name: "dv", type: "number", order: 1, precision: 0 }),
  fp({ id: D_DL, tableId: RT.d, name: "DL", type: "links", order: 2, relatedTableId: RT.c, relationKind: "mm", linkDisplayFieldId: "c_name" }),
  fp({ id: D_DLUP, tableId: RT.d, name: "dlup", type: "lookup", order: 3, linkFieldId: D_DL, lookupFieldId: "cv" }),
];

// ---- X / Y 双侧 null 环 ----
export const X_LINK = "x_ylink";
export const X_XF = "xf";
export const xFields: FieldMeta[] = [
  fp({ id: "x_name", tableId: RT.x, name: "X名", type: "singleLineText", order: 0 }),
  fp({ id: X_LINK, tableId: RT.x, name: "Y", type: "links", order: 1, relatedTableId: RT.y, relationKind: "mm", linkDisplayFieldId: "y_name" }),
  fp({ id: X_XF, tableId: RT.x, name: "xf", type: "formula", order: 2, formula: "{Y.yf}" }),
];
export const Y_LINK = "y_xlink";
export const Y_YF = "yf";
export const yFields: FieldMeta[] = [
  fp({ id: "y_name", tableId: RT.y, name: "Y名", type: "singleLineText", order: 0 }),
  fp({ id: Y_LINK, tableId: RT.y, name: "X", type: "links", order: 1, relatedTableId: RT.x, relationKind: "mm", linkDisplayFieldId: "x_name" }),
  fp({ id: Y_YF, tableId: RT.y, name: "yf", type: "formula", order: 2, formula: "{X.xf}" }),
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

export function lr(id: string, linkFieldId: string, parentRowId: string, childRowId: string, ord = 0): LinkRowRef {
  return { id, linkFieldId, parentRowId, childRowId, ord };
}

export interface RingStore {
  store: RawRecord[];
  links: LinkRowRef[];
  fieldsByTable: Record<string, FieldMeta[]>;
}

/** 构造标准环夹具（每次新数组，用例间隔离） */
export function buildRingStore(): RingStore {
  const store: RawRecord[] = [
    rc("a1", RT.a, { [A_NAME]: "A1", [A_NUM]: 100 }),
    rc("a0", RT.a, { [A_NAME]: "A0", [A_NUM]: 101 }),
    rc("b1", RT.b, { [B_NAME]: "B1", [B_NUM]: 200 }),
    rc("b0", RT.b, { [B_NAME]: "B0", [B_NUM]: 201 }),
    rc("c1", RT.c, { [C_NAME]: "C1", [C_CV]: 7 }),
    rc("p1", RT.p, { [P_NAME]: "P1" }),
    rc("p2", RT.p, { [P_NAME]: "P2" }),
    rc("d1", RT.d, { [D_NAME]: "D1", [D_DV]: 42 }),
    rc("x1", RT.x, { x_name: "X1" }),
    rc("y1", RT.y, { y_name: "Y1" }),
  ];
  const links: LinkRowRef[] = [
    lr("lab", A_AB, "a1", "b1"),   // R3 环正向
    lr("lba", B_BA, "b1", "a1"),   // R3 环反向
    lr("lac", A_AC, "a1", "c1"),   // R6 a1 的 lookup 边
    // R7 用：环记录 b1 自身挂 BC→c1。这样若引擎支持真两跳 {AB.BC.cv} 会取到 7；
    // 现状只切第一个点、subName="BC.cv" 在 B 表无同名字段 → null（锁能力边界）。
    lr("lbc", B_BC, "b1", "c1"),
    lr("lp1", P_PD, "p1", "d1"),   // R4 钻石路径 1
    lr("lp2", P_PD, "p2", "d1"),   // R4 钻石路径 2（共享 d1）
    lr("ldl", D_DL, "d1", "c1"),   // d1 自身 lookup
    lr("lxy", X_LINK, "x1", "y1"), // 双侧环
    lr("lyx", Y_LINK, "y1", "x1"),
  ];
  const fieldsByTable: Record<string, FieldMeta[]> = {
    [RT.a]: aFields, [RT.b]: bFields, [RT.c]: cFields,
    [RT.p]: pFields, [RT.d]: dFields, [RT.x]: xFields, [RT.y]: yFields,
  };
  return { store, links, fieldsByTable };
}

export interface TraceEvent {
  /** 底层（绕过 BatchStore 缓存）真实回源事件，按发生顺序 */
  op: "records" | "links" | "fields";
  ids?: string[];
  table?: string;
  linkFieldId?: string;
}

export interface RingDeps extends HydrateDeps {
  events: TraceEvent[];
  countOf(id: string): number;
}

/**
 * 计数 + 时序追踪 deps：每次触底记录事件。
 * 注意：走 hydrateRecords 批量路径时事件来自 BatchStore 预热与 cache-miss 兜底；
 * 走 hydrateRecordsLegacy 时事件即旧逐行 N+1 形状。两者取值必须一致（逐值对拍另锁）。
 */
export function traceDeps(s: RingStore): RingDeps {
  const events: TraceEvent[] = [];
  const fieldsOf = (tableId: string): FieldMeta[] =>
    s.fieldsByTable[tableId] ?? [];
  return {
    events,
    countOf(id: string): number {
      return events.reduce((n, e) => n + (e.op === "records" && e.ids?.includes(id) ? 1 : 0), 0);
    },
    async getFields(tableId) {
      events.push({ op: "fields", table: tableId });
      return fieldsOf(tableId);
    },
    async getRecordsByIds(ids) {
      events.push({ op: "records", ids: [...ids] });
      return s.store.filter((r) => ids.includes(r.id));
    },
    async getLinkRows(q) {
      events.push({ op: "links", linkFieldId: q.linkFieldId ?? "*" });
      return s.links.filter(
        (l) =>
          (!q.linkFieldId || l.linkFieldId === q.linkFieldId) &&
          (!q.parentRowId || l.parentRowId === q.parentRowId) &&
          (!q.childRowId || l.childRowId === q.childRowId),
      );
    },
    async countLinkRows() {
      return 0;
    },
    async getRecordOrdinal() {
      return 0;
    },
    async resolveUserName(userId) {
      return userId === "u1" ? "老板" : userId;
    },
  };
}
