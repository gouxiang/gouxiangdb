// M1/S5 两阶段批量化对拍：
//  1) 程序化逐值全等：batch（默认 hydrateRecords）与 legacy（hydrateRecordsLegacy）在宽类型
//     夹具（2 links 正/反 + lookup + rollup + count + 物理/链式/点引用公式 + 自引用 + 双向环）
//     上，对 N 行每一行的完整 fields 做结构化 deep-equal（不只快照，逐条 assert.deepEqual）。
//  2) 查询常量化：同一夹具 N=10 与 N=100，注入计数 deps（无 getLinkRowsBulk，模拟最朴素 deps），
//     getFields/getRecordsByIds/getLinkRows 的【调用次数】必须完全相等（schema 常量），
//     仅批大小随行数变化——证明查询数不随页内行数 N 线性增长（旧实现 19/20 会随 N 涨）。
//
// 内存 deps，不触库；计数口径与 S0 _hydrationFixture.countingDeps 一致。

import { describe, it, expect } from "vitest";
import { hydrateRecords, hydrateRecordsLegacy, type HydrateDeps, type LinkRowRef } from "../hydrate.js";
import type { FieldMeta, RawRecord, FieldValue } from "../types.js";

// ---- 表/字段 id ----
const TC = "t_cust"; // 客户表
const TO = "t_order"; // 订单表
const TX = "t_x";
const TY = "t_y";

const C_NAME = "c_name";
const C_RATE = "c_rate";
const C_ORDERS = "c_orders"; // 反向 hm
const O_NAME = "o_name";
const O_QTY = "o_qty";
const O_CUST = "o_cust"; // bt → cust
const O_PEER = "o_peer"; // hm 自引用
const O_CUSTNAME = "o_custname"; // lookup
const O_RATESUM = "o_ratesum"; // rollup sum
const O_CUSTCOUNT = "o_custcount"; // count
const O_FPHYS = "o_fphys"; // 公式：物理字段
const O_FCHAIN = "o_fchain"; // 公式：引用 O_FPHYS（链式）
const O_FDOT = "o_fdot"; // 公式：点引用 {客户.费率}
const X_LINK = "x_link";
const X_F = "x_f";
const Y_LINK = "y_link";
const Y_F = "y_f";

function fp(p: Partial<FieldMeta> & Pick<FieldMeta, "id" | "tableId" | "name" | "type" | "order">): FieldMeta {
  return {
    description: "", required: false, unique: false, options: null, precision: null, maxLength: null,
    defaultNow: false, recordFilter: null, linkFieldId: null, relatedTableId: null, relationKind: null,
    isReverse: false, reverseFieldId: null, linkDisplayFieldId: null, lookupFieldId: null,
    rollupFunction: null, formula: null, tabsConfig: null, displayedFieldIds: null, visibleFieldIds: null,
    defaultConfig: null, numberRule: null, ...p,
  } as FieldMeta;
}

const custFields: FieldMeta[] = [
  fp({ id: C_NAME, tableId: TC, name: "客户名", type: "singleLineText", order: 0 }),
  fp({ id: C_RATE, tableId: TC, name: "费率", type: "number", order: 1, precision: 0 }),
  fp({ id: C_ORDERS, tableId: TC, name: "订单（反向）", type: "links", order: 2, relatedTableId: TO,
      relationKind: "hm", isReverse: true, reverseFieldId: O_CUST, linkFieldId: O_CUST, linkDisplayFieldId: O_NAME }),
];

const orderFields: FieldMeta[] = [
  fp({ id: O_NAME, tableId: TO, name: "订单名", type: "singleLineText", order: 0 }),
  fp({ id: O_QTY, tableId: TO, name: "数量", type: "number", order: 1, precision: 0 }),
  fp({ id: O_CUST, tableId: TO, name: "客户", type: "links", order: 2, relatedTableId: TC,
      relationKind: "bt", linkDisplayFieldId: C_NAME }),
  fp({ id: O_PEER, tableId: TO, name: "关联订单", type: "links", order: 3, relatedTableId: TO,
      relationKind: "hm", linkDisplayFieldId: O_NAME }),
  fp({ id: O_CUSTNAME, tableId: TO, name: "客户名查找", type: "lookup", order: 4,
      linkFieldId: O_CUST, lookupFieldId: C_NAME }),
  fp({ id: O_RATESUM, tableId: TO, name: "费率汇总", type: "rollup", order: 5,
      linkFieldId: O_CUST, lookupFieldId: C_RATE, rollupFunction: "sum" }),
  fp({ id: O_CUSTCOUNT, tableId: TO, name: "客户数", type: "count", order: 6, linkFieldId: O_CUST }),
  fp({ id: O_FPHYS, tableId: TO, name: "物理公式", type: "formula", order: 7, formula: "CONCAT({订单名}, ':', {数量})" }),
  fp({ id: O_FCHAIN, tableId: TO, name: "链式公式", type: "formula", order: 8, formula: "CONCAT({物理公式}, '!')" }),
  fp({ id: O_FDOT, tableId: TO, name: "客户费率点引用", type: "formula", order: 9, formula: "{客户.费率}" }),
];

const xFields: FieldMeta[] = [
  fp({ id: "x_name", tableId: TX, name: "X名", type: "singleLineText", order: 0 }),
  fp({ id: X_LINK, tableId: TX, name: "Y", type: "links", order: 1, relatedTableId: TY, relationKind: "mm", linkDisplayFieldId: "y_name" }),
  fp({ id: X_F, tableId: TX, name: "X环", type: "formula", order: 2, formula: "{Y.Y环}" }),
];
const yFields: FieldMeta[] = [
  fp({ id: "y_name", tableId: TY, name: "Y名", type: "singleLineText", order: 0 }),
  fp({ id: Y_LINK, tableId: TY, name: "X", type: "links", order: 1, relatedTableId: TX, relationKind: "mm", linkDisplayFieldId: "x_name" }),
  fp({ id: Y_F, tableId: TY, name: "Y环", type: "formula", order: 2, formula: "{X.X环}" }),
];

function rc(id: string, tableId: string, f: Record<string, FieldValue>): RawRecord {
  return {
    id, tableId, fields: f,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    createdBy: "", updatedBy: "",
  };
}

interface Fixture {
  store: RawRecord[];
  links: LinkRowRef[];
}

/** 构造 N 个订单（每单链 1 个客户，客户数 K=4 循环；订单间自引用链）+ 双向环 X/Y。 */
function build(n: number): Fixture {
  const K = 4;
  const store: RawRecord[] = [];
  const links: LinkRowRef[] = [];
  for (let i = 0; i < K; i++) {
    store.push(rc(`cust${i}`, TC, { [C_NAME]: `客户${i}`, [C_RATE]: 100 * (i + 1) }));
  }
  for (let i = 0; i < n; i++) {
    const ci = i % K;
    store.push(rc(`ord${i}`, TO, { [O_NAME]: `O${i}`, [O_QTY]: i + 1 }));
    links.push({ id: `lk_c_${i}`, linkFieldId: O_CUST, parentRowId: `ord${i}`, childRowId: `cust${ci}`, ord: 0 });
    // 自引用：订单 i 关联订单 (i+1)%n，形成含环链
    links.push({ id: `lk_p_${i}`, linkFieldId: O_PEER, parentRowId: `ord${i}`, childRowId: `ord${(i + 1) % n}`, ord: 0 });
  }
  store.push(rc("x1", TX, { x_name: "X1" }));
  store.push(rc("y1", TY, { y_name: "Y1" }));
  links.push({ id: "lkx", linkFieldId: X_LINK, parentRowId: "x1", childRowId: "y1", ord: 0 });
  links.push({ id: "lky", linkFieldId: Y_LINK, parentRowId: "y1", childRowId: "x1", ord: 0 });
  return { store, links };
}

function fieldsOf(tableId: string): FieldMeta[] {
  if (tableId === TC) return custFields;
  if (tableId === TO) return orderFields;
  if (tableId === TX) return xFields;
  return yFields;
}

interface Counts {
  getFields: number; getRecordsByIds: number; getLinkRows: number;
  recordSizes: number[]; linkCalls: number;
}

/** 朴素计数 deps（不提供 getLinkRowsBulk，模拟最普通的 HydrateDeps 实现）。 */
function countingDeps(store: RawRecord[], links: LinkRowRef[]): HydrateDeps & { counts: Counts } {
  const counts: Counts = { getFields: 0, getRecordsByIds: 0, getLinkRows: 0, recordSizes: [], linkCalls: 0 };
  return {
    counts,
    async getFields(tableId) {
      counts.getFields++;
      return fieldsOf(tableId);
    },
    async getRecordsByIds(ids) {
      counts.getRecordsByIds++;
      counts.recordSizes.push(ids.length);
      return store.filter((r) => ids.includes(r.id));
    },
    async getLinkRows(q) {
      counts.getLinkRows++;
      counts.linkCalls++;
      return links.filter(
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
    async resolveUserName(uid) {
      return uid;
    },
  };
}

function orderRows(fx: Fixture): RawRecord[] {
  return fx.store.filter((r) => r.tableId === TO);
}

describe("S5 batch vs legacy 程序化逐值 deep-equal（宽类型，N=100）", () => {
  it("100 行订单每一行的完整 fields 在两种实现下结构化全等", async () => {
    const n = 100;
    const fx = build(n);

    const d1 = countingDeps(fx.store, fx.links);
    const batch = await hydrateRecords(orderRows(fx), orderFields, d1);

    const d2 = countingDeps(fx.store, fx.links);
    const legacy = await hydrateRecordsLegacy(orderRows(fx), orderFields, d2);

    expect(batch).toHaveLength(n);
    expect(legacy).toHaveLength(n);
    const bMap = new Map(batch.map((r) => [r.id, r]));
    for (const lr of legacy) {
      const br = bMap.get(lr.id)!;
      // 逐行完整 fields 结构化 deep-equal（含 LinkRef 数组顺序、lookup 数组、rollup 标量、公式类型）
      expect(br.fields).toEqual(lr.fields);
      expect(br.id).toBe(lr.id);
      expect(br.tableId).toBe(lr.tableId);
    }

    // 抽检关键值口径（RC-32 多子记录不 join、点引用保留 number 类型、rollup/count）
    const o0 = bMap.get("ord0")!.fields;
    expect(o0[O_CUSTNAME]).toEqual(["客户0"]);
    expect(o0[O_RATESUM]).toBe(100);
    expect(o0[O_CUSTCOUNT]).toBe(1);
    expect(o0[O_FDOT]).toBe(100); // 单关联点引用 → 标量 number
    expect(typeof o0[O_FDOT]).toBe("number");
    expect(o0[O_FPHYS]).toBe("O0:1");
    expect(o0[O_FCHAIN]).toBe("O0:1!");
    // bt 客户 LinkRef
    expect(o0[O_CUST]).toEqual([{ tableId: TC, recordId: "cust0", title: "客户0" }]);
    // 自引用 hm 不 join 成串，是 LinkRef 数组
    expect(o0[O_PEER]).toEqual([{ tableId: TO, recordId: "ord1", title: "O1" }]);
  });

  it("双向点引用环在 batch 下两侧公式置 null，不无限递归", async () => {
    const fx = build(2);
    const d = countingDeps(fx.store, fx.links);
    const xs = await hydrateRecords(fx.store.filter((r) => r.tableId === TX), xFields, d);
    const ys = await hydrateRecords(fx.store.filter((r) => r.tableId === TY), yFields, countingDeps(fx.store, fx.links));
    expect(xs.find((r) => r.id === "x1")!.fields[X_F]).toBeNull();
    expect(ys.find((r) => r.id === "y1")!.fields[Y_F]).toBeNull();
  });
});

describe("S5 查询常量化：调用次数不随页内行数 N 增长", () => {
  async function run(n: number): Promise<Counts> {
    const fx = build(n);
    const d = countingDeps(fx.store, fx.links);
    // 预热到稳定返回（不 await 具体值，仅触发完整 BFS + 计算）
    await hydrateRecords(orderRows(fx), orderFields, d);
    return d.counts;
  }

  // GX_HYDRATE_PREFETCH=off 时 hydrateRecords 回退 legacy，调用数随 N 增长，常量断言不成立 → 跳过；
  // 下方 legacy 线性对照与上方 batch↔legacy 逐值对拍两态都跑（off 时 batch 即 legacy，仍全等）。
  const itBatchConst = it.skipIf(process.env.GX_HYDRATE_PREFETCH === "off");
  itBatchConst("N=10 与 N=100 的 getFields/getRecordsByIds/getLinkRows 调用次数完全相等", async () => {
    const c10 = await run(10);
    const c100 = await run(100);
    // 三种查询的【次数】是 schema 常量，不随行数增长：
    expect(c100.getFields).toBe(c10.getFields);
    expect(c100.getRecordsByIds).toBe(c10.getRecordsByIds);
    expect(c100.getLinkRows).toBe(c10.getLinkRows);
    // 具体常量值锁死：fields 跨 2 表（cust 因 links/lookup 触及 + order 根表由调用方传入）；
    // linkRows = 3 个不同正向 linkFieldId（o_cust/o_peer/x-y 不被 order 触及，故仅订单链路 2 个）；
    // records IN 仅对端 cust 一批（订单根 + 自引用对端全在根缓存）。
    expect(c100.getLinkRows).toBe(2);
    expect(c100.getRecordsByIds).toBe(1);
    // 批大小随 N 变大（对端 cust 固定 K=4 → 一条 IN 取 4；订单自引用对端全是根，无额外 IN）。
    expect(Math.max(...c100.recordSizes)).toBeGreaterThanOrEqual(Math.max(...c10.recordSizes));
  });

  it("legacy 对照：旧实现 getLinkRows/getRecordsByIds 随 N 线性增长（证明对拍有效）", async () => {
    const fx10 = build(10);
    const d10 = countingDeps(fx10.store, fx10.links);
    await hydrateRecordsLegacy(orderRows(fx10), orderFields, d10);
    const fx100 = build(100);
    const d100 = countingDeps(fx100.store, fx100.links);
    await hydrateRecordsLegacy(orderRows(fx100), orderFields, d100);
    // 旧实现逐行/逐字段 N+1：N 增大调用数显著增多（线性）。
    expect(d100.counts.getLinkRows).toBeGreaterThan(d10.counts.getLinkRows);
    expect(d100.counts.getRecordsByIds).toBeGreaterThan(d10.counts.getRecordsByIds);
    expect(d100.counts.getLinkRows).toBeGreaterThan(20);
  });
});
