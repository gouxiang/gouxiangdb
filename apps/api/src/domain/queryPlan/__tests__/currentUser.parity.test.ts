// 动态 currentUser 端到端对拍（真迁移临时库 + 真 Prisma + sync 写 sidecar）：
//  - 物理计划器 runQueryPlan 与 S5 内存路径 queryRecordsLegacy 对 createdBy/lastModifiedBy
//    的 currentUser 条件逐值一致；
//  - 不同登录用户得到不同的行；
//  - displayName 重名也按 userId 精确匹配（u1/u2 同名"张三"，互不误命中）；
//  - 无登录态 fail-closed：含 NOT 包裹也不放行任何行。

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
let tmpDir: string;
let dbFile: string;
let prisma: PrismaClient;
let raw: Database.Database;
let tableId: string;
let fields: FieldMetaList;
let F: Record<string, string>;

let mod: {
  runQueryPlan: typeof import("../planner.js")["runQueryPlan"];
  syncRecordsTx: typeof import("../../fieldIndex/sync.js")["syncRecordsTx"];
  queryRecordsLegacy: typeof import("../../recordService.js")["queryRecordsLegacy"];
  parseViewConfig: typeof import("../../recordService.js")["parseViewConfig"];
  loadTableFields: typeof import("../../recordService.js")["loadTableFields"];
};

const baseConfig = (): ViewConfig => mod.parseViewConfig(null);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gx-cu-"));
  dbFile = path.join(tmpDir, "p.db");
  process.env.DATABASE_URL = `file:${dbFile}`;
  process.env.GX_M1_SIDECAR = "on";
  delete process.env.GX_M1_SIDECAR_READ;
  execSync("pnpm exec prisma migrate deploy --schema=prisma/schema.prisma", {
    cwd: process.cwd(), stdio: "ignore", env: process.env,
  });
  prisma = new PrismaClient();
  globalThis.__gx_prisma = prisma;
  const [planner, sync, rec] = await Promise.all([
    import("../planner.js"),
    import("../../fieldIndex/sync.js"),
    import("../../recordService.js"),
  ]);
  mod = {
    runQueryPlan: planner.runQueryPlan,
    syncRecordsTx: sync.syncRecordsTx,
    queryRecordsLegacy: rec.queryRecordsLegacy,
    parseViewConfig: rec.parseViewConfig,
    loadTableFields: rec.loadTableFields,
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
    creator: await mk("创建人", "createdBy", 1),
    editor: await mk("修改人", "lastModifiedBy", 2),
  };
  await prisma.table.update({ where: { id: tableId }, data: { primaryFieldId: F.name } });

  // 三个用户：u1/u2 displayName 同名"张三"（重名场景），u3 叫"李四"。
  // createdBy/updatedBy 直接写 userId（物理列）。
  const rows = [
    { title: "r1", createdBy: "u1", updatedBy: "u2" },
    { title: "r2", createdBy: "u2", updatedBy: "u1" },
    { title: "r3", createdBy: "u3", updatedBy: "u3" },
  ];
  await prisma.record.createMany({
    data: rows.map((r, i) => ({
      tableId,
      fields: JSON.stringify({ [F.name]: r.title }),
      createdBy: r.createdBy,
      updatedBy: r.updatedBy,
      createdAt: new Date(Date.parse("2026-02-01T00:00:00.000Z") + i),
      updatedAt: new Date(Date.parse("2026-02-01T00:00:00.000Z") + i),
    })),
  });
  const ids = (await prisma.record.findMany({
    where: { tableId, deletedAt: null },
    select: { id: true },
  })).map((r) => r.id);
  await prisma.$transaction((tx) => mod.syncRecordsTx(tx, tableId, ids));

  fields = await mod.loadTableFields(tableId);
  raw = new Database(dbFile, { readonly: true });
});

const currentUserFilter = (fieldId: string, op: string): FilterNode =>
  ({ kind: "condition", fieldId, op, value: "", valueType: "dynamic", dynamicValue: "currentUser" }) as FilterNode;

/** 物理计划器 vs 内存路径：断言命中的记录标题集合相等。 */
async function matchedTitles(filters: ViewConfig["filters"], currentUserId: string | null): Promise<{ planned: string[]; legacy: string[] }> {
  const config: ViewConfig = { ...baseConfig(), filters };
  const common = { tableId, fields, config, limit: 200, offset: 0, noPaging: true, search: "" };
  const planned = await mod.runQueryPlan(createSidecarQuerier(raw), { ...common, currentUserId });
  const legacy = await mod.queryRecordsLegacy({ ...common, currentUserId });
  const titleOf = (fid: string) => (r: (typeof planned.records)[number]) => (r.fields[fid] as string);
  const sortT = (a: string[], b: string[]) => {
    const sa = [...a].sort(); const sb = [...b].sort();
    expect(sa).toEqual(sb);
  };
  const pt = planned.records.map(titleOf(F.name));
  const lt = legacy.records.map(titleOf(F.name));
  sortT(pt, lt);
  return { planned: [...pt].sort(), legacy: [...lt].sort() };
}

describe("currentUser 内存 vs 物理路径一致", () => {
  it("createdBy is 当前用户：u1 只命中 r1（按 userId，不命中同名 u2 的 r2）", async () => {
    const { planned } = await matchedTitles(currentUserFilter(F.creator, "is"), "u1");
    expect(planned).toEqual(["r1"]);
  });

  it("createdBy is：u2 只命中 r2；u3 只命中 r3", async () => {
    expect((await matchedTitles(currentUserFilter(F.creator, "is"), "u2")).planned).toEqual(["r2"]);
    expect((await matchedTitles(currentUserFilter(F.creator, "is"), "u3")).planned).toEqual(["r3"]);
  });

  it("createdBy isNot 当前用户：u1 命中 r2,r3（不是自己创建的）", async () => {
    const { planned } = await matchedTitles(currentUserFilter(F.creator, "isNot"), "u1");
    expect(planned).toEqual(["r2", "r3"]);
  });

  it("lastModifiedBy is：u1 命中 r2（updatedBy=u1）", async () => {
    expect((await matchedTitles(currentUserFilter(F.editor, "is"), "u1")).planned).toEqual(["r2"]);
    expect((await matchedTitles(currentUserFilter(F.editor, "is"), "u2")).planned).toEqual(["r1"]);
  });
});

describe("currentUser fail-closed（无登录态）", () => {
  it("无 currentUserId：is 命中 0 行，不放开全表", async () => {
    expect((await matchedTitles(currentUserFilter(F.creator, "is"), null)).planned).toEqual([]);
  });

  it("无 currentUserId：isNot 也命中 0 行（反向操作不放行）", async () => {
    expect((await matchedTitles(currentUserFilter(F.creator, "isNot"), null)).planned).toEqual([]);
  });

  it("NOT 包裹的 currentUser 在无登录态仍 0 行 —— !(false) 不得放开", async () => {
    const filters: ViewConfig["filters"] = { kind: "not", child: currentUserFilter(F.creator, "is") };
    expect((await matchedTitles(filters, null)).planned).toEqual([]);
  });

  it("与其他物理条件 AND，无登录态仍 0 行", async () => {
    const filters: ViewConfig["filters"] = {
      kind: "and",
      children: [
        { kind: "condition", fieldId: F.name, op: "is", value: "r1" },
        currentUserFilter(F.creator, "is"),
      ],
    };
    expect((await matchedTitles(filters, null)).planned).toEqual([]);
  });
});
