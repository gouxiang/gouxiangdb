// apps/api/scripts/bench/gen/schema.ts
// M1/S9：压测库【结构 shape】（纯数据、确定性，不碰 DB）。
// 严格复刻生产 createField/createLinkFieldPair 的最终元数据形状（尤其 links 双向配对），
// 保证 lookup/rollup/count/formula 能被真实 hydrate 计算。所有 id 由 prng.seqId 固定分配，
// 因此同 --seed 两次生成的字段 id 完全一致 → records.fields 的 JSON key 逐字节可复现。
//
// 结构（--shape wide）：
//   peer 窄表（4 字段，关联对端）：标题(主)/数值(number)/类别(singleSelect)/发生日(date)
//   main 宽表 30 字段：主字段 + longText + 数值五型 + 日期两型 + checkbox + 单选8 + 多选≤5
//     + email/url/phone + autoNumber + 2 links(mm,hm→peer) + lookup + rollup(sum) + count
//     + 链式 formula + 点引用 formula + attachment(1KB 占位) + 补充物理字段。
// --shape narrow：标题/备注/数量/状态 4 字段（对齐历史 2000 行 4 字段口径）。

import { seqId } from "./prng.js";

/** bench 固定登录凭据（run-gate 走真实 /api/auth/login，不伪造 JWT）。 */
export const BENCH_EMAIL = "bench@gouxiangdb.local";
export const BENCH_PASSWORD = "bench-password-123";
/** BENCH_PASSWORD 的固定 bcrypt 哈希（bcrypt 自带随机盐，必须固化才能逐字节复现）。 */
export const BENCH_PASSWORD_HASH = "$2a$10$J230ngSuFO.p1LA1nNY/meYPn1Lvdf5Xw2fe1VQuhBwFeyozi9RjS";

const STATUS_OPTIONS = ["待处理", "进行中", "已完成", "已阻塞", "已取消", "待复核", "已归档", "紧急"];
const TAG_OPTIONS = ["红", "橙", "黄", "绿", "蓝", "靛", "紫", "灰"];
const PEER_CAT_OPTIONS = ["甲类", "乙类", "丙类", "丁类"];
const PRIORITY_OPTIONS = ["P0", "P1", "P2", "P3"];
const PALETTE = ["#378ADD", "#0F6E56", "#B8860B", "#8B3A3A", "#5B4B8A", "#2E7D6F", "#9A5B12", "#566B86"];

/** 字段定义（直写 fields 表的一行，列名对齐 Prisma model Field）。 */
export interface FieldDef {
  id: string;
  tableId: string;
  name: string;
  type: string;
  order: number;
  options?: string; // 已 JSON.stringify
  precision?: number | null;
  defaultNow?: boolean;
  recordFilter?: string | null;
  relatedTableId?: string | null;
  relationKind?: string | null;
  linkFieldId?: string | null;
  reverseFieldId?: string | null;
  isReverse?: boolean;
  linkDisplayFieldId?: string | null;
  lookupFieldId?: string | null;
  rollupFunction?: string | null;
  formula?: string | null;
  numberRule?: string | null;
}

/** 带类型/名称的字段句柄，供 rows.ts 取值用。 */
export interface FieldHandle {
  id: string;
  name: string;
  type: string;
}

export interface Shape {
  baseId: string;
  ownerId: string;
  mainTableId: string;
  peerTableId: string;
  fieldDefs: FieldDef[]; // 两张表全部字段（直写顺序）
  viewId: string;
  main: Record<string, FieldHandle>;
  peer: Record<string, FieldHandle>;
}

/** bench 身份（base + owner）。narrow 多表共用同一 owner，规避 email 唯一约束。 */
export interface Identities {
  baseId: string;
  ownerId: string;
}

export function buildIdentities(): Identities {
  return { baseId: seqId("base"), ownerId: seqId("user") };
}

function detOptions(prefix: string, names: string[]): string {
  return JSON.stringify(
    names.map((name, i) => ({ id: `${prefix}_opt_${i}`, name, color: PALETTE[i % PALETTE.length]! })),
  );
}

/** 窄表结构：单表 4 字段（无关联/计算字段）。identity 由调用方共享。 */
export function buildNarrowShape(id: Identities): Shape {
  const { baseId, ownerId } = id;
  const tableId = seqId("tbl");
  const viewId = seqId("view");
  const fieldDefs: FieldDef[] = [];
  const main: Record<string, FieldHandle> = {};

  const add = (key: string, name: string, type: string, extra: Partial<FieldDef> = {}): void => {
    const id = seqId("fld");
    fieldDefs.push({
      id, tableId, name, type, order: fieldDefs.length,
      precision: null, defaultNow: false, recordFilter: null,
      relatedTableId: null, relationKind: null, linkFieldId: null, reverseFieldId: null,
      isReverse: false, linkDisplayFieldId: null, lookupFieldId: null,
      rollupFunction: null, formula: null, numberRule: null, options: undefined,
      ...extra,
    });
    main[key] = { id, name, type };
  };

  add("title", "标题", "singleLineText");
  add("note", "备注", "longText");
  add("num", "数量", "number", { precision: 0 });
  add("status", "状态", "singleSelect", { options: detOptions("stn", STATUS_OPTIONS.slice(0, 4)) });

  return {
    baseId, ownerId, mainTableId: tableId, peerTableId: "", fieldDefs, viewId,
    main, peer: {},
  };
}

/** 宽表结构：main 30 字段 + peer 4 字段 + 两类 links 及计算字段（确定性 id）。 */
export function buildWideShape(id: Identities): Shape {
  const { baseId, ownerId } = id;
  const peerTableId = seqId("tbl");
  const mainTableId = seqId("tbl");
  const viewId = seqId("view");
  const fieldDefs: FieldDef[] = [];
  const main: Record<string, FieldHandle> = {};
  const peer: Record<string, FieldHandle> = {};

  const std = (): Partial<FieldDef> => ({
    precision: null, defaultNow: false, recordFilter: null,
    relatedTableId: null, relationKind: null, linkFieldId: null, reverseFieldId: null,
    isReverse: false, linkDisplayFieldId: null, lookupFieldId: null,
    rollupFunction: null, formula: null, numberRule: null,
  });

  // ---- peer 字段（order 从 0 起，独立表）----
  const addPeer = (key: string, name: string, type: string, extra: Partial<FieldDef> = {}): void => {
    const id = seqId("fld");
    fieldDefs.push({ id, tableId: peerTableId, name, type, order: fieldDefs.filter((d) => d.tableId === peerTableId).length, ...std(), ...extra });
    peer[key] = { id, name, type };
  };
  addPeer("title", "标题", "singleLineText");
  addPeer("num", "数值", "number", { precision: 0 });
  addPeer("cat", "类别", "singleSelect", { options: detOptions("pcat", PEER_CAT_OPTIONS) });
  addPeer("date", "发生日", "date");

  // ---- main 字段 ----
  const addMain = (key: string, name: string, type: string, extra: Partial<FieldDef> = {}): void => {
    const id = seqId("fld");
    fieldDefs.push({ id, tableId: mainTableId, name, type, order: fieldDefs.filter((d) => d.tableId === mainTableId).length, ...std(), ...extra });
    main[key] = { id, name, type };
  };

  // 物理字段（17）
  addMain("title", "标题", "singleLineText");
  addMain("note", "备注", "longText");
  addMain("num", "数量", "number", { precision: 0 });
  addMain("money", "金额", "currency", { precision: 2 });
  addMain("rate", "比率", "percent", { precision: 1 });
  addMain("dur", "时长", "duration");
  addMain("score", "评分", "rating");
  addMain("date", "日期", "date");
  addMain("datetime", "时间戳", "datetime");
  addMain("enabled", "启用", "checkbox");
  addMain("status", "状态", "singleSelect", { options: detOptions("stat", STATUS_OPTIONS) });
  addMain("tags", "标签", "multiSelect", { options: detOptions("tag", TAG_OPTIONS) });
  addMain("email", "邮箱", "email");
  addMain("url", "网址", "url");
  addMain("phone", "电话", "phone");
  addMain("autonum", "编号", "autoNumber", {
    numberRule: JSON.stringify({ segments: [{ type: "fixed", text: "GX" }, { type: "counter", digits: 5, reset: "never" }] }),
  });
  addMain("city", "城市", "singleLineText");

  // links 双向配对：严格复刻 createLinkFieldPair 最终态（forward.linkFieldId=reverse.id；
  // reverse.linkFieldId=reverseFieldId=forward.id；hm 的反向 relationKind=bt）。
  const linkPair = (fwdKey: string, name: string, kind: string): void => {
    const reverseKind = kind === "hm" ? "bt" : "mm";
    const revId = seqId("fld");
    const fwdId = seqId("fld");
    const display = peer.title!.id;
    // 反向字段（在 peer）
    fieldDefs.push({
      id: revId, tableId: peerTableId, name: `${name}（反向）`, type: "links",
      order: fieldDefs.filter((d) => d.tableId === peerTableId).length, ...std(),
      relatedTableId: mainTableId, relationKind: reverseKind, isReverse: true,
      linkFieldId: fwdId, reverseFieldId: fwdId, linkDisplayFieldId: display,
    });
    // 正向字段（在 main）
    fieldDefs.push({
      id: fwdId, tableId: mainTableId, name, type: "links",
      order: fieldDefs.filter((d) => d.tableId === mainTableId).length, ...std(),
      relatedTableId: peerTableId, relationKind: kind, isReverse: false,
      linkFieldId: revId, linkDisplayFieldId: display,
    });
    main[fwdKey] = { id: fwdId, name, type: "links" };
  };
  linkPair("children", "子项", "mm");
  linkPair("ownerLink", "归属", "hm");

  // 计算字段（6）：lookup / rollup(sum) / count / 链式 formula×2（引用另一公式）/ 点引用 formula
  addMain("childTitle", "子项标题", "lookup", {
    linkFieldId: main.children!.id, lookupFieldId: peer.title!.id,
  });
  addMain("childSum", "子项金额合计", "rollup", {
    linkFieldId: main.children!.id, lookupFieldId: peer.num!.id, rollupFunction: "sum",
  });
  addMain("childCount", "子项数", "count", { linkFieldId: main.children!.id });
  addMain("tax", "税额", "formula", { formula: "{金额}*0.1" });
  addMain("gross", "含税", "formula", { formula: "{金额}+{税额}" });
  addMain("firstChild", "首个子项", "formula", { formula: "{子项.标题}" });
  // 附件（1，1KB 占位，不灌 dataURL）
  addMain("attach", "附件", "attachment");
  // 补充物理字段（4）→ 17+2+6+1+4 = 30
  addMain("heat", "热度", "number");
  addMain("progress", "完成度", "percent");
  addMain("priority", "优先级", "singleSelect", { options: detOptions("prio", PRIORITY_OPTIONS) });
  addMain("updatedOn", "更新日", "datetime");

  return { baseId, ownerId, mainTableId, peerTableId, fieldDefs, viewId, main, peer };
}

export function fieldCount(s: Shape): { main: number; peer: number } {
  return {
    main: s.fieldDefs.filter((d) => d.tableId === s.mainTableId).length,
    peer: s.fieldDefs.filter((d) => d.tableId === s.peerTableId).length,
  };
}
