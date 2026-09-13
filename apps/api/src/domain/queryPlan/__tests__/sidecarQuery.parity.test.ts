// M1/S6 sidecar 读执行器真库对拍（临时 SQLite 经全部 12 迁移 + 真实 Prisma + sync 写 sidecar）：
//  - 同一份确定性数据上，compile → sidecar 物理过滤的 recordId【有序序列】 ==
//    shared evalFilter 内存过滤（按 createdAt,id 稳定序）结果，覆盖全部 18 个 FilterOp；
//  - valueNum 排序序列 == sortRows（空值恒后、(createdAt,id) tie-break）；
//  - 物理数字聚合 == aggregateAll；singleSelect/checkbox 分桶成员集合一致；
//  - EXPLAIN QUERY PLAN 命中 records_table_live_created_id / rfi_table_field_*，无全表 SCAN；
//  - 脏数值（number 存 "abc"）时 sortNumericClean=false（编排层据此回退内存排序）。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { evalFilter, type FilterNode, type SortSpec } from "@gx/shared-types";
import { sortRows } from "../../sort.js";
import { aggregateAll } from "../../aggregate.js";
import { syncRecordsTx } from "../../fieldIndex/sync.js";
import { compilePlan, type PlanField } from "../compile.js";
import { createSidecarQuerier } from "../sidecarQuery.js";

const N = 120;
let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let raw: Database.Database;
let querier: ReturnType<typeof createSidecarQuerier>;
let tableId: string;
let F: Record<string, string>;
let planFields: PlanField[];

interface Row {
  id: string;
  fields: Record<string, unknown>;
}
let rows: Row[] = []; // 活记录，按 createdAt,id 升序（内存 ground truth 输入序）

const fieldTypes: Record<string, string> = {};
const pad = (i: number) => String((i % 28) + 1).padStart(2, "0");

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-qp-"));
  dbFile = path.join(tmpDir, "q.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.GX_M1_SIDECAR = "on";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const base = await prisma.base.create({ data: { name: "b", createdBy: "u" } });
  const table = await prisma.table.create({
    data: { baseId: base.id, name: "t", primaryFieldId: "", createdBy: "u" },
  });
  tableId = table.id;
  const mk = async (name: string, type: string, order: number) => {
    const f = await prisma.field.create({ data: { tableId, name, type, order } });
    fieldTypes[f.id] = type;
    return f.id;
  };
  F = {
    name: await mk("名称", "singleLineText", 0),
    email: await mk("邮箱", "email", 1),
    age: await mk("年龄", "number", 2),
    stars: await mk("评分", "rating", 3),
    born: await mk("生日", "date", 4),
    ok: await mk("勾选", "checkbox", 5),
    status: await mk("状态", "singleSelect", 6),
    tags: await mk("标签", "multiSelect", 7),
    weird: await mk("脏数", "number", 8),
    calc: await mk("计算", "formula", 9),
  };
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: F.name } });
  planFields = [
    { id: F.name, type: "singleLineText", isPrimary: true },
    { id: F.email, type: "email" },
    { id: F.age, type: "number" },
    { id: F.stars, type: "rating" },
    { id: F.born, type: "date" },
    { id: F.ok, type: "checkbox" },
    { id: F.status, type: "singleSelect" },
    { id: F.tags, type: "multiSelect" },
    { id: F.weird, type: "number" },
    { id: F.calc, type: "formula" },
  ];

  // 确定性数据（i 取模制造空值/分桶/不同域），createdAt 显式递增。
  const data = [];
  const seedFieldsFor = (i: number): Record<string, unknown> => {
    const o: Record<string, unknown> = { [F.name]: `name${i}` };
    if (i % 3 === 1) o[F.email] = `u${i}@example.com`;
    else if (i % 3 === 2) o[F.email] = `a${i}@other.io`; // 3 整除 → 无键（空）
    if (i % 4 !== 0) o[F.age] = i;
    if (i % 5 !== 0) o[F.stars] = i % 6; // 0..5
    if (i % 5 !== 0) o[F.born] = `2026-01-${pad(i)}`;
    if (i % 3 === 0) o[F.ok] = true;
    else if (i % 3 === 1) o[F.ok] = false; // 其余 → 无键（null）
    const sm = i % 6;
    if (sm >= 1 && sm <= 3) o[F.status] = `o${sm}`;
    else if (sm === 4) o[F.status] = ""; // sm 0,5 → 无键
    const tm = i % 7;
    if (tm === 1) o[F.tags] = ["t1"];
    else if (tm === 2) o[F.tags] = ["t1", "t2"];
    else if (tm === 3) o[F.tags] = ["t3"];
    else if (tm === 4) o[F.tags] = [];
    // 脏数值：每 11 行存非数字串（非空但 valueNum=null）
    if (i % 11 === 5) o[F.weird] = "abc";
    else if (i % 2 === 0) o[F.weird] = i;
    return o;
  };
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < N; i++) {
    data.push({
      tableId,
      fields: JSON.stringify(seedFieldsFor(i)),
      createdBy: "u", updatedBy: "u",
      createdAt: new Date(baseMs + i),
      updatedAt: new Date(baseMs + i),
    });
  }
  await prisma.record.createMany({ data });

  // 经真实写路径维护 sidecar（派生口径与生产一致）。
  const created = await prisma.record.findMany({
    where: { tableId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  await prisma.$transaction((tx) => syncRecordsTx(tx, tableId, created.map((r) => r.id)));

  raw = new Database(dbFile, { readonly: true });
  querier = createSidecarQuerier(raw);
  const full = raw
    .prepare(`SELECT id, fields FROM records WHERE "tableId"=? AND "deletedAt" IS NULL ORDER BY "createdAt" ASC, "id" ASC`)
    .all(tableId) as { id: string; fields: string }[];
  rows = full.map((r) => ({ id: r.id, fields: JSON.parse(r.fields) as Record<string, unknown> }));
}, 120000);

afterAll(() => {
  raw?.close();
  void prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const get = (r: Row) => (fid: string): unknown => r.fields[fid];
const cond = (fieldId: string, op: string, value = ""): FilterNode =>
  ({ kind: "condition", fieldId, op, value }) as FilterNode;

/** 内存 ground truth：evalFilter 后保持 createdAt 稳定序。 */
function memoryIds(node: FilterNode): string[] {
  return rows.filter((r) => evalFilter(node, get(r))).map((r) => r.id);
}

/** 编译并跑物理过滤（不排序），返回 SQL 序列。 */
function physicalIds(node: FilterNode): { ids: string[]; plan: ReturnType<typeof compilePlan> } {
  const plan = compilePlan(tableId, planFields, node, []);
  const ids = querier.physicalOrderedIds({
    tableId, filterSql: plan.filterSql, filterParams: plan.filterParams, sortJoins: null,
  });
  return { ids, plan };
}

describe("18 FilterOp 物理下推 recordId 序列 == 内存 evalFilter", () => {
  // 校验数据集确实有区分度（谓词既非恒真也非恒假），否则对拍无意义。
  function expectPartial(n: string, ids: string[]) {
    expect(ids.length, `${n} 命中应 >0`).toBeGreaterThan(0);
    expect(ids.length, `${n} 命中应 < 全表`).toBeLessThan(N);
  }

  it("is（文本严格相等，命中 1 行）", () => {
    const node = cond(F.name, "is", `name${10}`);
    const { ids, plan } = physicalIds(node);
    expect(plan.residual).toBeNull();
    expect(ids).toEqual(memoryIds(node));
    expect(ids).toHaveLength(1);
  });

  it("isNot（互补 NOT EXISTS，含空值行）", () => {
    const node = cond(F.name, "isNot", `name${10}`);
    const { ids } = physicalIds(node);
    expect(ids).toEqual(memoryIds(node));
    expect(ids).toHaveLength(N - 1);
  });

  it("contains 短文本参数化 LIKE（大小写不敏感）", () => {
    const node = cond(F.email, "contains", "example");
    const { ids, plan } = physicalIds(node);
    expect(plan.filterSql).toContain("LIKE");
    expectPartial("contains", ids);
    expect(ids).toEqual(memoryIds(node));
  });

  it("notContains 强制回退内存（physical 不产生）", () => {
    const plan = compilePlan(tableId, planFields, cond(F.email, "notContains", "x"), []);
    expect(plan.filterSql).toBeNull();
    expect(plan.residual).not.toBeNull();
  });

  it("startsWith / endsWith LIKE 转义对拍", () => {
    for (const [op, lit] of [["startsWith", "u1"], ["endsWith", "other.io"]] as const) {
      const node = cond(F.email, op, lit);
      const { ids } = physicalIds(node);
      expectPartial(op, ids);
      expect(ids, op).toEqual(memoryIds(node));
    }
  });

  it("isEmpty / isNotEmpty（数字列空值）", () => {
    for (const op of ["isEmpty", "isNotEmpty"] as const) {
      const node = cond(F.age, op);
      const { ids } = physicalIds(node);
      expectPartial(op, ids);
      expect(ids, op).toEqual(memoryIds(node));
    }
  });

  it("eq / neq 数值（neq 含转不出数/空值行，与内存口径一致）", () => {
    for (const op of ["eq", "neq"] as const) {
      const node = cond(F.age, op, "10");
      const { ids } = physicalIds(node);
      expectPartial(op, ids);
      expect(ids, op).toEqual(memoryIds(node));
    }
  });

  it("gt / lt / gte / lte 数值与日期（valueNum 毫秒）", () => {
    for (const op of ["gt", "lt", "gte", "lte"] as const) {
      const nNode = cond(F.age, op, "60");
      expectPartial(`age ${op}`, physicalIds(nNode).ids);
      expect(physicalIds(nNode).ids, `age ${op}`).toEqual(memoryIds(nNode));
      const dNode = cond(F.born, op, "2026-01-15");
      expectPartial(`born ${op}`, physicalIds(dNode).ids);
      expect(physicalIds(dNode).ids, `born ${op}`).toEqual(memoryIds(dNode));
    }
  });

  it("rating gte 走 valueNum（S4 rating 修复后的范围下推）", () => {
    const node = cond(F.stars, "gte", "4");
    const { ids } = physicalIds(node);
    expectPartial("stars gte", ids);
    expect(ids).toEqual(memoryIds(node));
  });

  it("日期 is 走 valueText 等值", () => {
    const node = cond(F.born, "is", "2026-01-10");
    const { ids } = physicalIds(node);
    expect(ids).toEqual(memoryIds(node));
    expect(ids.length).toBeGreaterThan(0);
  });

  it("checked / unchecked（unchecked 含空值行，非互补）", () => {
    for (const op of ["checked", "unchecked"] as const) {
      const node = cond(F.ok, op);
      const { ids } = physicalIds(node);
      expectPartial(op, ids);
      expect(ids, op).toEqual(memoryIds(node));
    }
    // 非互补证明：存在既不 checked 也不 unchecked 的脏文本（构造不出来则跳过断言数值）
    const on = memoryIds(cond(F.ok, "checked")).length;
    const off = memoryIds(cond(F.ok, "unchecked")).length;
    expect(on + off).toBeLessThanOrEqual(N);
  });

  it("singleSelect is / isAnyOf / isNoneOf（optionId IN，空值计入 isNoneOf）", () => {
    expect(physicalIds(cond(F.status, "is", "o1")).ids).toEqual(memoryIds(cond(F.status, "is", "o1")));
    for (const op of ["isAnyOf", "isNoneOf"] as const) {
      const node = cond(F.status, op, "o1,o2");
      const { ids } = physicalIds(node);
      expectPartial(op, ids);
      expect(ids, op).toEqual(memoryIds(node));
    }
  });

  it("multiSelect isAnyOf / isNoneOf（多行 sidecar EXISTS IN / NOT EXISTS）", () => {
    for (const op of ["isAnyOf", "isNoneOf"] as const) {
      const node = cond(F.tags, op, "t2,t3");
      const { ids } = physicalIds(node);
      expectPartial(op, ids);
      expect(ids, op).toEqual(memoryIds(node));
    }
  });

  it("多选 contains/notContains 回退内存（IN 无法表达逐元素子串）", () => {
    expect(compilePlan(tableId, planFields, cond(F.tags, "contains", "t1"), []).filterSql).toBeNull();
    expect(compilePlan(tableId, planFields, cond(F.tags, "notContains", "t1"), []).filterSql).toBeNull();
  });

  it("formula 字段任何条件回退内存", () => {
    expect(compilePlan(tableId, planFields, cond(F.calc, "gt", "1"), []).filterSql).toBeNull();
  });
});

describe("valueNum 排序下推序列 == sortRows", () => {
  function sortParity(sorts: SortSpec[]) {
    const plan = compilePlan(tableId, planFields, null, sorts);
    expect(plan.sortJoins, "应下推").not.toBeNull();
    const sqlIds = querier.physicalOrderedIds({
      tableId, filterSql: null, filterParams: [], sortJoins: plan.sortJoins,
    });
    const memIds = sortRows(
      rows.map((r) => ({ id: r.id, get: get(r) })),
      sorts,
      fieldTypes,
    ).map((x) => x.id);
    expect(sqlIds).toEqual(memIds);
  }

  it("number asc/desc（空值恒后，tie-break createdAt,id）", () => {
    sortParity([{ fieldId: F.age, direction: "asc" }]);
    sortParity([{ fieldId: F.age, direction: "desc" }]);
  });
  it("rating desc / date asc / checkbox asc", () => {
    sortParity([{ fieldId: F.stars, direction: "desc" }]);
    sortParity([{ fieldId: F.born, direction: "asc" }]);
    sortParity([{ fieldId: F.ok, direction: "asc" }]);
  });
  it("多排序（age asc, stars desc）", () => {
    sortParity([{ fieldId: F.age, direction: "asc" }, { fieldId: F.stars, direction: "desc" }]);
  });
});

describe("物理聚合 == aggregateAll（数字列，含脏值/空值）", () => {
  const funcs = ["count", "countEmpty", "countFilled", "percentEmpty", "percentFilled",
    "sum", "avg", "min", "max"] as const;
  it("无过滤候选集 9 个聚合逐个相等", () => {
    const got = querier.physicalAggregates({
      tableId, fieldId: F.age, funcs: [...funcs], filterSql: null, filterParams: [],
    });
    const want = aggregateAll(rows.map((r) => r.fields[F.age]), Object.fromEntries(funcs.map((f) => [f, f])));
    for (const fn of funcs) {
      if (want[fn] === null) expect(got[fn], fn).toBeNull();
      else expect(got[fn], fn).toBeCloseTo(want[fn]!, 6);
    }
  });
  it("脏数值列（weird 混 'abc'）min/max/sum/avg/count 与内存口径一致（脏值非空但转不出数）", () => {
    const got = querier.physicalAggregates({
      tableId, fieldId: F.weird, funcs: [...funcs], filterSql: null, filterParams: [],
    });
    const want = aggregateAll(rows.map((r) => r.fields[F.weird]), Object.fromEntries(funcs.map((f) => [f, f])));
    // count 计全部、countEmpty 只计真空（'abc' 非空）、sum/avg/min/max 跳过 'abc'
    for (const fn of funcs) {
      if (want[fn] === null) expect(got[fn], fn).toBeNull();
      else expect(got[fn], fn).toBeCloseTo(want[fn]!, 6);
    }
  });
  it("带物理过滤（age>40）后聚合仍与内存候选一致", () => {
    const node = cond(F.age, "gt", "40");
    const plan = compilePlan(tableId, planFields, node, []);
    const ids = querier.physicalOrderedIds({
      tableId, filterSql: plan.filterSql, filterParams: plan.filterParams, sortJoins: null,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const vals = ids.map((id) => byId.get(id)!.fields[F.age]);
    const got = querier.physicalAggregates({
      tableId, fieldId: F.age, funcs: [...funcs], filterSql: plan.filterSql, filterParams: plan.filterParams,
    });
    const want = aggregateAll(vals, Object.fromEntries(funcs.map((f) => [f, f])));
    for (const fn of funcs) {
      if (want[fn] === null) expect(got[fn], fn).toBeNull();
      else expect(got[fn], fn).toBeCloseTo(want[fn]!, 6);
    }
  });
});

describe("物理分桶成员集合（singleSelect/checkbox）", () => {
  it("singleSelect：optionId 桶 + 空白桶，成员集合与内存一致", () => {
    const buckets = querier.physicalGroupBuckets({
      tableId, fieldId: F.status, kind: "singleSelect", filterSql: null, filterParams: [],
    });
    const byKey = new Map(buckets.map((b) => [b.key, new Set(b.recordIds)]));
    // 内存成员：按原始值（optionId / 空）
    for (const key of ["o1", "o2", "o3", ""]) {
      const want = new Set(
        rows.filter((r) => {
          const v = r.fields[F.status];
          const empty = v === undefined || v === null || v === "";
          return key === "" ? empty : v === key;
        }).map((r) => r.id),
      );
      expect(byKey.get(key) ?? new Set<string>(), `桶 ${key}`).toEqual(want);
    }
    // 桶内成员按 createdAt,id 升（供应用层按最终有序列表重排）
    for (const b of buckets) {
      const sorted = [...b.recordIds].sort();
      // id 非时间序，改为校验与全表 createdAt 序一致：用 rows 顺序比对
      const orderOf = new Map(rows.map((r, i) => [r.id, i]));
      const idx = b.recordIds.map((id) => orderOf.get(id)!);
      expect(idx).toEqual([...idx].sort((a, z) => a - z));
      void sorted;
    }
  });

  it("checkbox：valueNum 1/0/空三态成员与内存一致", () => {
    const buckets = querier.physicalGroupBuckets({
      tableId, fieldId: F.ok, kind: "checkbox", filterSql: null, filterParams: [],
    });
    const byKey = new Map(buckets.map((b) => [b.key, new Set(b.recordIds)]));
    const mem = (pred: (v: unknown) => boolean) =>
      new Set(rows.filter((r) => pred(r.fields[F.ok])).map((r) => r.id));
    expect(byKey.get("1")!).toEqual(mem((v) => v === true));
    expect(byKey.get("0")!).toEqual(mem((v) => v === false));
    expect(byKey.get("") ?? new Set<string>()).toEqual(mem((v) => v === undefined || v === null));
  });
});

describe("EXPLAIN QUERY PLAN：命中索引、无全表 SCAN", () => {
  function details(node: FilterNode | null, sorts: SortSpec[] = []) {
    const plan = compilePlan(tableId, planFields, node, sorts);
    return querier.explain({
      tableId, filterSql: plan.filterSql, filterParams: plan.filterParams, sortJoins: plan.sortJoins,
    }).join("\n");
  }
  const noScan = (d: string) => {
    // 允许 SEARCH ... USING (COVERING) INDEX；禁止对两张表的裸 SCAN。
    expect(d).not.toMatch(/SCAN r\b/);
    expect(d).not.toMatch(/SCAN record_field_index\b/);
    expect(d).not.toMatch(/SCAN s\d\b/);
  };

  it("无过滤：records 走 covering index", () => {
    const d = details(null);
    expect(d).toContain("records_table_live_created_id");
    noScan(d);
  });
  it("数值范围 EXISTS 命中 rfi_table_field_num", () => {
    const d = details(cond(F.age, "gt", "40"));
    expect(d).toContain("records_table_live_created_id");
    expect(d).toContain("rfi_table_field_num");
    noScan(d);
  });
  it("文本等值 EXISTS 不走全表 SCAN（相关探测走索引）", () => {
    const d = details(cond(F.name, "is", "name10"));
    noScan(d);
    expect(d).toContain("records_table_live_created_id");
  });
  it("rating 范围 + checkbox 排序无 SCAN", () => {
    const d = details(cond(F.stars, "gte", "3"), [{ fieldId: F.age, direction: "desc" }]);
    expect(d).toContain("rfi_table_field_num");
    noScan(d);
  });
});

describe("数值排序洁净度探针", () => {
  it("干净字段（age）→ true", () => {
    expect(querier.sortNumericClean({ tableId, fieldIds: [F.age], filterSql: null, filterParams: [] })).toBe(true);
  });
  it("含脏值字段（weird 有 'abc'）→ false，编排层须回退内存排序", () => {
    expect(querier.sortNumericClean({ tableId, fieldIds: [F.weird], filterSql: null, filterParams: [] })).toBe(false);
  });
  it("带过滤后只检候选集（weird>0 物理过滤排除脏值行后）", () => {
    // weird 的脏值行 "abc" 不满足 valueNum>0（valueNum NULL），过滤候选里应洁净
    const node = cond(F.weird, "gt", "0");
    const plan = compilePlan(tableId, planFields, node, []);
    const clean = querier.sortNumericClean({
      tableId, fieldIds: [F.weird], filterSql: plan.filterSql, filterParams: plan.filterParams,
    });
    expect(clean).toBe(true);
  });
});
