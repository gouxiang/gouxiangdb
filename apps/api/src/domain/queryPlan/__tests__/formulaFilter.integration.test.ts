// 高级筛选（kind:"formula"）端到端集成（真迁移临时库 + 真 Prisma）：
//  formula 节点在 queryPlan 中不出 SQL，经 B 档宽口径在 hydrate 完毕的记录上内存求值，
//  严格布尔。覆盖：布尔真/假、非布尔结果 fail-closed、AND(物理条件 + 公式) 走内存精修、
//  空表达式放行、legacy 与 plan 两路径结果一致。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import type { FilterNode, ViewConfig } from "@gx/shared-types";
import { createSidecarQuerier } from "../sidecarQuery.js";

type FieldMetaList = Awaited<ReturnType<typeof import("../../recordService.js")["loadTableFields"]>>;
const N = 24;
let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let raw: Database.Database;
let tableId: string;
let fields: FieldMetaList;
let F: Record<string, string>;

let mod: {
  runQueryPlan: typeof import("../planner.js")["runQueryPlan"];
  queryRecordsLegacy: typeof import("../../recordService.js")["queryRecordsLegacy"];
  loadTableFields: typeof import("../../recordService.js")["loadTableFields"];
  parseViewConfig: typeof import("../../recordService.js")["parseViewConfig"];
  syncRecordsTx: typeof import("../../fieldIndex/sync.js")["syncRecordsTx"];
};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-ff-"));
  dbFile = path.join(tmpDir, "p.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.GX_M1_SIDECAR = "on";
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const [planner, rec, sync] = await Promise.all([
    import("../planner.js"),
    import("../../recordService.js"),
    import("../../fieldIndex/sync.js"),
  ]);
  mod = {
    runQueryPlan: planner.runQueryPlan,
    queryRecordsLegacy: rec.queryRecordsLegacy,
    loadTableFields: rec.loadTableFields,
    parseViewConfig: rec.parseViewConfig,
    syncRecordsTx: sync.syncRecordsTx,
  };
}, 120000);

afterAll(async () => {
  raw?.close();
  await prisma?.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  raw?.close();
  await prisma.record.deleteMany({});
  await prisma.field.deleteMany({});
  await prisma.table.deleteMany({});
  await prisma.base.deleteMany({});
  const base = await prisma.base.create({ data: { name: "b", createdBy: "u" } });
  const table = await prisma.table.create({
    data: { baseId: base.id, name: "t", primaryFieldId: "", createdBy: "u" },
  });
  tableId = table.id;
  const mk = async (name: string, type: string, order: number) =>
    (await prisma.field.create({ data: { tableId, name, type, order } })).id;
  F = {
    name: await mk("名称", "singleLineText", 0),
    age: await mk("年龄", "number", 1),
  };
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: F.name } });

  const data = [];
  const baseMs = Date.parse("2026-03-01T00:00:00.000Z");
  for (let i = 0; i < N; i++) {
    const o: Record<string, unknown> = { [F.name]: `记录${i}` };
    o[F.age] = i;
    data.push({
      tableId, fields: JSON.stringify(o), createdBy: "u", updatedBy: "u",
      createdAt: new Date(baseMs + i), updatedAt: new Date(baseMs + i),
    });
  }
  await prisma.record.createMany({ data });
  // 同步 sidecar rfi（物理粗筛依赖；缺同步时 rfi 为空，候选=0）
  const ids = (await prisma.record.findMany({
    where: { tableId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  })).map((r) => r.id);
  await prisma.$transaction((tx) => mod.syncRecordsTx(tx, tableId, ids));
  fields = await mod.loadTableFields(tableId);
  raw = new Database(dbFile, { readonly: true });
});

async function run(filters: FilterNode) {
  const config: ViewConfig = { ...mod.parseViewConfig(null), filters };
  const common = { tableId, fields, config, limit: 200, offset: 0, noPaging: true, search: "" };
  const q = createSidecarQuerier(raw);
  const planned = await mod.runQueryPlan(q, common);
  const legacy = await mod.queryRecordsLegacy(common);
  return { planned, legacy };
}

describe("高级公式筛选端到端", () => {
  it("布尔真谓词命中全部；假谓词命中 0", async () => {
    const { planned: t, legacy: lt } = await run({ kind: "formula", expression: "true" });
    expect(t.mode).toBe("wide");
    expect(t.filteredTotal).toBe(N);
    expect(t.records.map((r) => r.id)).toEqual(lt.records.map((r) => r.id));

    const { planned: f } = await run({ kind: "formula", expression: "false" });
    expect(f.filteredTotal).toBe(0);
    expect(f.records).toHaveLength(0);
  });

  it("字段比较：{年龄} >= 10 仅保留后半段", async () => {
    const { planned, legacy } = await run({ kind: "formula", expression: "{年龄} >= 10" });
    expect(planned.filteredTotal).toBe(N - 10);
    expect(planned.records.map((r) => r.id)).toEqual(legacy.records.map((r) => r.id));
  });

  it("非布尔结果 fail-closed：返回数字/字符串的公式不命中任何记录", async () => {
    const num = await run({ kind: "formula", expression: "{年龄} + 1" });
    expect(num.planned.filteredTotal).toBe(0);
    const str = await run({ kind: "formula", expression: '{名称}' });
    expect(str.planned.filteredTotal).toBe(0);
  });

  it("非法表达式 fail-closed（不抛错、不命中）", async () => {
    const { planned } = await run({ kind: "formula", expression: "{年龄} > " });
    expect(planned.filteredTotal).toBe(0);
  });

  it("AND(物理条件 age>=5, 公式 age<15)：内存精修得到交集 5..14", async () => {
    const node: FilterNode = {
      kind: "and",
      children: [
        { kind: "condition", fieldId: F.age, op: "gte", value: "5" },
        { kind: "formula", expression: "{年龄} < 15" },
      ],
    };
    const { planned, legacy } = await run(node);
    expect(planned.mode).toBe("wide");
    expect(planned.filteredTotal).toBe(10);
    expect(planned.records.map((r) => r.id)).toEqual(legacy.records.map((r) => r.id));
  });

  it("空表达式放行全部（无筛选）", async () => {
    const { planned } = await run({ kind: "formula", expression: "   " });
    expect(planned.filteredTotal).toBe(N);
  });
});
