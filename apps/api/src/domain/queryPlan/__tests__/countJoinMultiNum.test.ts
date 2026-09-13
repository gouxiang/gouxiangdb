// M1/S10 P0 回归：多个【标量数值字段高命中 AND】的 rfi JOIN 形态与计数/取页正确性。
// 背景（ADR-0008 T0 窄口径补门）：宽范围数值 AND 在偏态库（每字段 ≥80% 命中）时，若 SQLite
// 以 rfi_table_field_num 当 JOIN 驱动，多 JOIN 退化为内层 records 嵌套探测（实测双字段 26s、
// 三字段 52s）。compileCount.assemble 用 INDEXED BY rfi_record_field_ord_key 强制 records 覆盖
// 索引驱动、每个 rfi 按 recordId 等值回表后，双/三字段均毫秒。本测试用偏态高命中夹具锁形态与
// 数值全等，N=160 均匀夹具测不出，故刻意造偏态。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { evalFilter, type FilterNode } from "@gx/shared-types";
import { syncRecordsTx } from "../../fieldIndex/sync.js";
import { compilePlan, type PlanField } from "../compile.js";
import { createSidecarQuerier } from "../sidecarQuery.js";
import type { SidecarQuerier } from "../sidecarQuery.js";

// 偏态：三个数值字段各约 85% 落在宽区间（高命中），约 15% 在区间外，少量空值。
const N = 400;
const MONEY_RANGE = [1000, 9000] as const;
const NUM_RANGE = [50, 500] as const;
const RATE_RANGE = [1, 10] as const;

let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let raw: Database.Database;
let querier: SidecarQuerier;
let tableId: string;
let F: { money: string; num: string; rate: string };
let planFields: PlanField[];

interface Row {
  id: string;
  fields: Record<string, unknown>;
}
let rows: Row[] = []; // 活记录，按 createdAt,id 升序

/** 确定性偏态：约 85% 在宽区间内（值均匀分布于区间），约 12% 区间外小值，约 3% 空值。 */
function skewed(i: number, range: readonly [number, number], salt: number): number | null {
  const bucket = (i * 31 + salt * 977) % 100;
  if (bucket < 85) {
    const [lo, hi] = range;
    return Math.round((lo + ((i * 13 + salt * 7) % 1000) / 1000 * (hi - lo)) * 100) / 100;
  }
  if (bucket < 97) return Math.round(((i + salt) % 20) * 100) / 100; // 远低于下界的小值
  return null;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-multinum-"));
  dbFile = path.join(tmpDir, "m.db");
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
    return f.id;
  };
  const title = await mk("标题", "singleLineText", 0);
  F = {
    money: await mk("金额", "currency", 1),
    num: await mk("数量", "number", 2),
    rate: await mk("比率", "percent", 3),
  };
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: title } });
  planFields = [
    { id: title, type: "singleLineText", isPrimary: true },
    { id: F.money, type: "currency" },
    { id: F.num, type: "number" },
    { id: F.rate, type: "percent" },
  ];

  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  const data = [];
  for (let i = 0; i < N; i++) {
    const o: Record<string, unknown> = { [title]: `r${i}` };
    const money = skewed(i, MONEY_RANGE, 1);
    const num = skewed(i, NUM_RANGE, 2);
    const rate = skewed(i, RATE_RANGE, 3);
    if (money !== null) o[F.money] = money;
    if (num !== null) o[F.num] = num;
    if (rate !== null) o[F.rate] = rate;
    data.push({
      tableId,
      fields: JSON.stringify(o),
      createdBy: "u", updatedBy: "u",
      createdAt: new Date(baseMs + i),
      updatedAt: new Date(baseMs + i),
    });
  }
  await prisma.record.createMany({ data });

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

const cond = (fieldId: string, op: string, value: string): FilterNode =>
  ({ kind: "condition", fieldId, op, value }) as FilterNode;
const and = (children: FilterNode[]): FilterNode => ({ kind: "and", children });

function planFor(node: FilterNode) {
  return compilePlan(tableId, planFields, node, []);
}

/** 内存 ground truth：evalFilter 后保持 createdAt,id 稳定序（rows 已按此排序）。 */
function memoryMatch(node: FilterNode): Row[] {
  return rows.filter((r) => evalFilter(node, (fid: string) => r.fields[fid]));
}

function hitRate(node: FilterNode): number {
  return memoryMatch(node).length / rows.length;
}

describe("夹具区分度：三字段宽范围均高命中（≥80%），AND 后仍高命中", () => {
  it("单字段命中 ≈85%、三字段 AND 命中 >55%（确为偏态高命中，非均匀）", () => {
    const money = and([cond(F.money, "gte", "1000"), cond(F.money, "lte", "9000")]);
    const triple = and([
      cond(F.money, "gte", "1000"), cond(F.money, "lte", "9000"),
      cond(F.num, "gte", "50"), cond(F.num, "lte", "500"),
      cond(F.rate, "gte", "1"), cond(F.rate, "lte", "10"),
    ]);
    expect(hitRate(money)).toBeGreaterThanOrEqual(0.8);
    expect(hitRate(triple)).toBeGreaterThan(0.55);
    expect(hitRate(triple)).toBeLessThan(0.85); // AND 确有收窄，非恒真
  });
});

describe("EXPLAIN 形态（真库，单/双/三 JOIN）：records 覆盖索引驱动 + 每个 rfi 走 recordId 唯一索引", () => {
  /** 断言 COUNT 与 keyset 取页两条 SQL 的计划形态（不使用毫秒，只看计划结构）。 */
  function assertJoinShape(node: FilterNode, joinCount: number) {
    const plan = planFor(node);
    expect(plan.countPlan, "该过滤树应产出 countPlan JOIN 快速路径").not.toBeNull();
    const q = {
      tableId,
      filterSql: plan.filterSql,
      filterParams: plan.filterParams,
      countPlan: plan.countPlan,
    };
    for (const details of [querier.explainCount(q), querier.explainKeyset({ ...q, cursor: null, limit: 100 })]) {
      const text = details.join("\n");
      // 外层驱动必须是 records 的 live+createdAt 覆盖索引，不允许 rfi 范围索引当驱动。
      expect(text).toMatch(/SEARCH r USING (COVERING )?INDEX records_table_live_created_id/);
      // 每个 JOIN 内表 c0..cN 走 (recordId,fieldId,ord) 唯一索引按 recordId 回表。
      for (let i = 0; i < joinCount; i++) {
        expect(text).toMatch(new RegExp(`SEARCH c${i} USING INDEX rfi_record_field_ord_key`));
      }
      // 绝不允许 rfi_table_field_num/text 出现在 JOIN 计划里（那是嵌套循环驱动的根因）。
      expect(text).not.toMatch(/USING INDEX rfi_table_field_num/);
      expect(text).not.toMatch(/USING INDEX rfi_table_field_text/);
      // 无全表 SCAN。
      expect(text).not.toMatch(/SCAN r\b/);
      expect(text).not.toMatch(/SCAN record_field_index\b/);
      expect(text).not.toMatch(/SCAN c\d\b/);
    }
  }

  it("单字段范围 AND（1 JOIN）", () => {
    assertJoinShape(and([cond(F.money, "gte", "1000"), cond(F.money, "lte", "9000")]), 1);
  });
  it("双字段范围 AND（2 JOIN）", () => {
    assertJoinShape(and([
      cond(F.money, "gte", "1000"), cond(F.money, "lte", "9000"),
      cond(F.rate, "gte", "1"), cond(F.rate, "lte", "10"),
    ]), 2);
  });
  it("三字段范围 AND（3 JOIN）", () => {
    assertJoinShape(and([
      cond(F.money, "gte", "1000"), cond(F.money, "lte", "9000"),
      cond(F.num, "gte", "50"), cond(F.num, "lte", "500"),
      cond(F.rate, "gte", "1"), cond(F.rate, "lte", "10"),
    ]), 3);
  });
});

describe("偏态高命中多字段 AND：COUNT filteredTotal 与首页 id 序列 == 内存口径", () => {
  function parity(node: FilterNode) {
    const plan = planFor(node);
    expect(plan.countPlan).not.toBeNull();
    const q = {
      tableId,
      filterSql: plan.filterSql,
      filterParams: plan.filterParams,
      countPlan: plan.countPlan,
    };
    const wantRows = memoryMatch(node);

    // COUNT filteredTotal 全等（非毫秒断言；大计数正确性）。
    const gotCount = querier.countPhysical(q);
    expect(gotCount).toBe(wantRows.length);

    // 首页 100 id 与旧口径（createdAt,id 升序的内存序列）逐项全等。
    const page = querier.physicalKeysetOnCreatedAt({ ...q, cursor: null, limit: 100 });
    const wantFirst100 = wantRows.slice(0, 100).map((r) => r.id);
    expect(page.rows.map((r) => r.id)).toEqual(wantFirst100);
    expect(page.hasMore).toBe(wantRows.length > 100);
  }

  it("双字段 money+rate 高命中 AND", () => {
    parity(and([
      cond(F.money, "gte", "1000"), cond(F.money, "lte", "9000"),
      cond(F.rate, "gte", "1"), cond(F.rate, "lte", "10"),
    ]));
  });

  it("三字段 money+num+rate 高命中 AND", () => {
    parity(and([
      cond(F.money, "gte", "1000"), cond(F.money, "lte", "9000"),
      cond(F.num, "gte", "50"), cond(F.num, "lte", "500"),
      cond(F.rate, "gte", "1"), cond(F.rate, "lte", "10"),
    ]));
  });

  it("physicalCreatedPage 深页（offset=200,limit=100）序列也与内存口径全等", () => {
    const node = and([
      cond(F.money, "gte", "1000"), cond(F.money, "lte", "9000"),
      cond(F.num, "gte", "50"), cond(F.num, "lte", "500"),
      cond(F.rate, "gte", "1"), cond(F.rate, "lte", "10"),
    ]);
    const plan = planFor(node);
    const ids = querier.physicalCreatedPage({
      tableId,
      filterSql: plan.filterSql,
      filterParams: plan.filterParams,
      countPlan: plan.countPlan,
    }, 200, 100);
    const want = memoryMatch(node).slice(200, 300).map((r) => r.id);
    expect(ids).toEqual(want);
  });
});
